import type { BucketInfo, BucketQuotas, GarageAdminClient } from './client.js';
import { GarageAdminError } from './errors.js';
import { assertKeyPair, type KeyPair } from './keys.js';

export type EnsureBucketAccessInput = KeyPair & {
  /** Global alias of the bucket, which is the name S3 clients use. Created when missing. */
  bucket: string;
  /** Label of the key in Garage. Default: the bucket name. */
  keyName?: string;
  /** What the key may do on the bucket. Default: read and write, never owner. */
  permissions?: { read?: boolean; write?: boolean };
  /** Applied when set. Omit to leave the bucket's quotas as they are. */
  quotas?: BucketQuotas;
};

export type EnsureBucketAccessResult = { bucketId: string; bucket: string; accessKeyId: string };

export type RemoveBucketAccessInput = {
  bucket: string;
  accessKeyId: string;
  /** Delete the bucket too. Garage refuses while it holds objects (`conflict`). Default false. */
  deleteBucket?: boolean;
};

export type RemoveBucketAccessResult = { keyDeleted: boolean; bucketDeleted: boolean };

/**
 * Gives one application its own bucket and key. Idempotent: it converges on the same state however
 * many times it runs.
 *
 * - The bucket is created when missing.
 * - The key is imported with the given id and secret. Garage cannot change the secret of an
 *   existing key, so a key whose secret differs is deleted and imported again (rotation).
 * - The key gets read and write on this bucket only, and never `owner`, which would let it
 *   delete the bucket or change its permissions.
 */
export async function ensureBucketAccess(
  client: GarageAdminClient,
  input: EnsureBucketAccessInput,
): Promise<EnsureBucketAccessResult> {
  assertKeyPair(input, 'ensureBucketAccess');
  const permissions = {
    read: input.permissions?.read ?? true,
    write: input.permissions?.write ?? true,
  };
  if (!permissions.read && !permissions.write) {
    throw new GarageAdminError({
      kind: 'invalid',
      operation: 'ensureBucketAccess',
      message: 'garage: a key needs read or write on the bucket',
    });
  }

  const bucket = await ensureBucket(client, input.bucket);

  const existing = await client.getKey(input.accessKeyId, { showSecretKey: true });
  if (existing !== undefined && existing.secretAccessKey !== input.secretAccessKey) {
    await client.deleteKey(input.accessKeyId);
  }
  if (existing === undefined || existing.secretAccessKey !== input.secretAccessKey) {
    await client.importKey({
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
      name: input.keyName ?? input.bucket,
    });
  }

  await client.allowBucketKey({
    bucketId: bucket.id,
    accessKeyId: input.accessKeyId,
    permissions: { ...permissions, owner: false },
  });
  // `AllowBucketKey` only adds, so drop anything this key holds beyond what was asked for.
  const held = (await client.getBucketById(bucket.id))?.keys.find(
    (key) => key.accessKeyId === input.accessKeyId,
  )?.permissions;
  const excess = {
    read: held?.read === true && !permissions.read,
    write: held?.write === true && !permissions.write,
    owner: held?.owner === true,
  };
  if (excess.read || excess.write || excess.owner) {
    await client.denyBucketKey({
      bucketId: bucket.id,
      accessKeyId: input.accessKeyId,
      permissions: excess,
    });
  }

  if (input.quotas !== undefined) await client.updateBucketQuotas(bucket.id, input.quotas);

  return { bucketId: bucket.id, bucket: input.bucket, accessKeyId: input.accessKeyId };
}

/**
 * Revokes an application's access: deletes its key, so its credentials stop working at once, and
 * optionally the bucket. Idempotent: a key or bucket that is already gone counts as removed.
 */
export async function removeBucketAccess(
  client: GarageAdminClient,
  input: RemoveBucketAccessInput,
): Promise<RemoveBucketAccessResult> {
  const key = await client.getKey(input.accessKeyId);
  if (key !== undefined) await client.deleteKey(input.accessKeyId);

  let bucketDeleted = false;
  if (input.deleteBucket === true) {
    const bucket = await client.getBucketByAlias(input.bucket);
    if (bucket !== undefined) await client.deleteBucket(bucket.id);
    bucketDeleted = true;
  }
  return { keyDeleted: key !== undefined, bucketDeleted };
}

async function ensureBucket(client: GarageAdminClient, alias: string): Promise<BucketInfo> {
  const found = await client.getBucketByAlias(alias);
  if (found !== undefined) return found;
  try {
    return await client.createBucket(alias);
  } catch (error) {
    // Lost a race with a concurrent ensure: the bucket exists now, which is what we wanted.
    if (error instanceof GarageAdminError && error.kind === 'conflict') {
      const created = await client.getBucketByAlias(alias);
      if (created !== undefined) return created;
    }
    throw error;
  }
}
