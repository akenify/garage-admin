type Perm = { read: boolean; write: boolean; owner: boolean };
type Bucket = {
  id: string;
  aliases: string[];
  objects: number;
  quotas: { maxSize?: number | null; maxObjects?: number | null };
  keys: Map<string, Perm>;
};
type Key = { accessKeyId: string; name: string; secretAccessKey: string };

export type RecordedCall = { operation: string; query: Record<string, string>; body: unknown };

/**
 * In-memory stand-in for the slice of the Garage v2 admin API this package uses. It enforces the
 * rules that matter to the helpers: unique aliases, import fails on an existing key, a bucket must
 * be empty to be deleted, and permissions only ever get added by `AllowBucketKey`.
 */
export function createFakeGarage(token = 'admin-token') {
  const buckets = new Map<string, Bucket>();
  const keys = new Map<string, Key>();
  /** Garage keeps a tombstone: a deleted key id can never be imported again. */
  const deletedKeys = new Set<string>();
  const calls: RecordedCall[] = [];
  let nextId = 1;

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fail = (status: number, code: string) => json(status, { code, message: code });

  const bucketBody = (bucket: Bucket) => ({
    id: bucket.id,
    globalAliases: bucket.aliases,
    keys: [...bucket.keys].map(([accessKeyId, permissions]) => ({
      accessKeyId,
      name: keys.get(accessKeyId)?.name ?? '',
      permissions,
    })),
    objects: bucket.objects,
    bytes: 0,
    unfinishedUploads: 0,
    quotas: bucket.quotas,
  });

  const fakeFetch = (async (input: URL | string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const operation = url.pathname.replace('/v2/', '');
    const query = Object.fromEntries(url.searchParams);
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ operation, query, body });

    const authorization = new Headers(init?.headers).get('authorization');
    if (authorization !== `Bearer ${token}`) return fail(403, 'AccessDenied');

    const findBucket = () =>
      query.id !== undefined
        ? buckets.get(query.id)
        : [...buckets.values()].find((bucket) => bucket.aliases.includes(query.globalAlias ?? ''));
    const b = body as Record<string, any> | undefined;

    switch (operation) {
      case 'GetBucketInfo': {
        const bucket = findBucket();
        return bucket ? json(200, bucketBody(bucket)) : fail(404, 'NoSuchBucket');
      }
      case 'CreateBucket': {
        const alias = String(b?.globalAlias);
        if ([...buckets.values()].some((bucket) => bucket.aliases.includes(alias))) {
          return fail(409, 'BucketAlreadyExists');
        }
        const bucket: Bucket = {
          id: `bucket-${nextId++}`,
          aliases: [alias],
          objects: 0,
          quotas: {},
          keys: new Map(),
        };
        buckets.set(bucket.id, bucket);
        return json(200, bucketBody(bucket));
      }
      case 'DeleteBucket': {
        const bucket = findBucket();
        if (!bucket) return fail(404, 'NoSuchBucket');
        if (bucket.objects > 0) return fail(409, 'BucketNotEmpty');
        buckets.delete(bucket.id);
        return new Response(null, { status: 204 });
      }
      case 'UpdateBucket': {
        const bucket = findBucket();
        if (!bucket) return fail(404, 'NoSuchBucket');
        bucket.quotas = b?.quotas ?? bucket.quotas;
        return json(200, bucketBody(bucket));
      }
      case 'GetKeyInfo': {
        const key = keys.get(query.id ?? '');
        if (!key) return fail(404, 'NoSuchAccessKey');
        return json(200, {
          accessKeyId: key.accessKeyId,
          name: key.name,
          secretAccessKey: query.showSecretKey === 'true' ? key.secretAccessKey : null,
          buckets: [],
        });
      }
      case 'ListKeys':
        return json(
          200,
          [...keys.values()].map((key) => ({
            id: key.accessKeyId,
            name: key.name,
            expired: false,
          })),
        );
      case 'ImportKey': {
        if (keys.has(String(b?.accessKeyId)) || deletedKeys.has(String(b?.accessKeyId))) {
          return fail(409, 'KeyAlreadyExists');
        }
        const key: Key = {
          accessKeyId: String(b?.accessKeyId),
          name: String(b?.name ?? ''),
          secretAccessKey: String(b?.secretAccessKey),
        };
        keys.set(key.accessKeyId, key);
        return json(200, { accessKeyId: key.accessKeyId, name: key.name, buckets: [] });
      }
      case 'DeleteKey': {
        if (!keys.delete(query.id ?? '')) return fail(404, 'NoSuchAccessKey');
        deletedKeys.add(query.id ?? '');
        for (const bucket of buckets.values()) bucket.keys.delete(query.id ?? '');
        return new Response(null, { status: 204 });
      }
      case 'AllowBucketKey':
      case 'DenyBucketKey': {
        const bucket = buckets.get(String(b?.bucketId));
        if (!bucket) return fail(404, 'NoSuchBucket');
        if (!keys.has(String(b?.accessKeyId))) return fail(404, 'NoSuchAccessKey');
        const held = bucket.keys.get(String(b?.accessKeyId)) ?? {
          read: false,
          write: false,
          owner: false,
        };
        const value = operation === 'AllowBucketKey';
        for (const flag of ['read', 'write', 'owner'] as const) {
          if (b?.permissions?.[flag] === true) held[flag] = value;
        }
        bucket.keys.set(String(b?.accessKeyId), held);
        return json(200, bucketBody(bucket));
      }
      default:
        return fail(400, 'InvalidRequest');
    }
  }) as typeof fetch;

  return {
    fetch: fakeFetch,
    token,
    calls,
    buckets,
    keys,
    /** Pretend the application wrote objects, so the bucket is no longer empty. */
    addObjects(alias: string, count: number) {
      const bucket = [...buckets.values()].find((candidate) => candidate.aliases.includes(alias));
      if (bucket) bucket.objects += count;
    },
  };
}
