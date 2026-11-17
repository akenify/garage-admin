import { GarageAdminError, kindForStatus } from './errors.js';

export type GarageAdminConfig = {
  /** Origin of the admin API, for example `http://garage:3903`. */
  endpoint: string;
  /** Admin API token (`GARAGE_ADMIN_TOKEN` or one made with `CreateAdminToken`). */
  token: string;
  /** Milliseconds before a request is abandoned. Default 15000. */
  timeoutMs?: number;
  /** Injectable for tests. Default: the global `fetch`. */
  fetch?: typeof fetch;
};

export type BucketKeyPermissions = { read: boolean; write: boolean; owner: boolean };

export type BucketQuotas = { maxSize?: number | null; maxObjects?: number | null };

export type BucketInfo = {
  id: string;
  globalAliases: string[];
  keys: { accessKeyId: string; name: string; permissions: BucketKeyPermissions }[];
  objects: number;
  bytes: number;
  unfinishedUploads: number;
  quotas: BucketQuotas;
};

export type KeyInfo = {
  accessKeyId: string;
  name: string;
  /** Only present when requested with `showSecretKey`. */
  secretAccessKey?: string | null;
  buckets: { id: string; globalAliases: string[]; permissions: BucketKeyPermissions }[];
};

type Query = Record<string, string | boolean | undefined>;

/**
 * Typed client for the Garage v2 admin API. Covers the operations needed to give an application
 * its own bucket and credentials; it is not a full client. Every failure is a `GarageAdminError`.
 */
export class GarageAdminClient {
  readonly #endpoint: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(config: GarageAdminConfig) {
    let url: URL;
    try {
      url = new URL(config.endpoint);
    } catch {
      throw new GarageAdminError({
        kind: 'invalid',
        operation: 'client',
        message: 'garage: invalid admin endpoint URL',
      });
    }
    if (config.token.length === 0) {
      throw new GarageAdminError({
        kind: 'invalid',
        operation: 'client',
        message: 'garage: admin token is empty',
      });
    }
    this.#endpoint = url.origin;
    this.#token = config.token;
    this.#timeoutMs = config.timeoutMs ?? 15_000;
    this.#fetch = config.fetch ?? fetch;
  }

  async #request<T>(
    operation: string,
    method: 'GET' | 'POST',
    query: Query = {},
    body?: unknown,
  ): Promise<T> {
    const url = new URL(`/v2/${operation}`, this.#endpoint);
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new GarageAdminError({
        kind: 'network',
        operation,
        message: `garage ${operation} failed: ${timedOut ? 'timed out' : 'could not connect'}`,
      });
    }
    if (!response.ok) {
      const code = await errorCode(response);
      throw new GarageAdminError({
        kind: kindForStatus(response.status),
        operation,
        status: response.status,
        ...(code === undefined ? {} : { code }),
        message: `garage ${operation} failed: ${response.status}${code === undefined ? '' : ` ${code}`}`,
      });
    }
    const text = await response.text();
    return (text.length === 0 ? undefined : JSON.parse(text)) as T;
  }

  /** The bucket with this global alias, or `undefined` when there is none. */
  async getBucketByAlias(alias: string): Promise<BucketInfo | undefined> {
    return this.#orUndefined(
      this.#request<BucketInfo>('GetBucketInfo', 'GET', { globalAlias: alias }),
    );
  }

  async getBucketById(id: string): Promise<BucketInfo | undefined> {
    return this.#orUndefined(this.#request<BucketInfo>('GetBucketInfo', 'GET', { id }));
  }

  /** Creates a bucket reachable under `globalAlias`. Fails with `conflict` when it is taken. */
  async createBucket(globalAlias: string): Promise<BucketInfo> {
    return this.#request<BucketInfo>('CreateBucket', 'POST', {}, { globalAlias });
  }

  /** Garage only deletes empty buckets: a full one fails with `conflict` (`BucketNotEmpty`). */
  async deleteBucket(id: string): Promise<void> {
    await this.#request<void>('DeleteBucket', 'POST', { id });
  }

  async updateBucketQuotas(id: string, quotas: BucketQuotas): Promise<void> {
    await this.#request<void>('UpdateBucket', 'POST', { id }, { quotas });
  }

  /** The key, or `undefined`. With `showSecretKey` the response includes the secret. */
  async getKey(
    accessKeyId: string,
    options: { showSecretKey?: boolean } = {},
  ): Promise<KeyInfo | undefined> {
    return this.#orUndefined(
      this.#request<KeyInfo>('GetKeyInfo', 'GET', {
        id: accessKeyId,
        ...(options.showSecretKey === true ? { showSecretKey: true } : {}),
      }),
    );
  }

  /** Every key, with the name it was created with. Never includes secrets. */
  async listKeys(): Promise<{ accessKeyId: string; name: string }[]> {
    const keys = await this.#request<{ id: string; name: string }[]>('ListKeys', 'GET');
    return keys.map((key) => ({ accessKeyId: key.id, name: key.name }));
  }

  /** Imports a key with a chosen id and secret. Fails with `conflict` when the id exists. */
  async importKey(input: {
    accessKeyId: string;
    secretAccessKey: string;
    name?: string;
  }): Promise<KeyInfo> {
    return this.#request<KeyInfo>('ImportKey', 'POST', {}, input);
  }

  async deleteKey(accessKeyId: string): Promise<void> {
    await this.#request<void>('DeleteKey', 'POST', { id: accessKeyId });
  }

  /** Adds the `true` permissions only; permissions left `false` are not removed. */
  async allowBucketKey(input: {
    bucketId: string;
    accessKeyId: string;
    permissions: Partial<BucketKeyPermissions>;
  }): Promise<void> {
    await this.#request<unknown>('AllowBucketKey', 'POST', {}, withAllPermissions(input));
  }

  /** Removes the `true` permissions only. */
  async denyBucketKey(input: {
    bucketId: string;
    accessKeyId: string;
    permissions: Partial<BucketKeyPermissions>;
  }): Promise<void> {
    await this.#request<unknown>('DenyBucketKey', 'POST', {}, withAllPermissions(input));
  }

  async #orUndefined<T>(request: Promise<T>): Promise<T | undefined> {
    try {
      return await request;
    } catch (error) {
      if (error instanceof GarageAdminError && error.kind === 'not_found') return undefined;
      throw error;
    }
  }
}

/** Garage's permission object lists all three flags. */
function withAllPermissions(input: {
  bucketId: string;
  accessKeyId: string;
  permissions: Partial<BucketKeyPermissions>;
}) {
  const { read = false, write = false, owner = false } = input.permissions;
  return {
    bucketId: input.bucketId,
    accessKeyId: input.accessKeyId,
    permissions: { read, write, owner },
  };
}

async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { code?: unknown };
    return typeof body.code === 'string' ? body.code : undefined;
  } catch {
    return undefined;
  }
}
