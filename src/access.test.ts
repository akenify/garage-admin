import { describe, expect, it } from 'vitest';
import { ensureBucketAccess, removeBucketAccess, rotateBucketAccess } from './access.js';
import { GarageAdminClient } from './client.js';
import { generateKeyPair } from './keys.js';
import { createFakeGarage } from './testing/fake-garage.js';

function setup() {
  const fake = createFakeGarage();
  const client = new GarageAdminClient({
    endpoint: 'http://garage:3903',
    token: fake.token,
    fetch: fake.fetch,
  });
  return { fake, client };
}

const permsOf = (fake: ReturnType<typeof createFakeGarage>, alias: string, accessKeyId: string) =>
  [...fake.buckets.values()].find((b) => b.aliases.includes(alias))?.keys.get(accessKeyId);

describe('ensureBucketAccess', () => {
  it('creates the bucket and key with read and write, never owner', async () => {
    const { fake, client } = setup();
    const pair = generateKeyPair();
    const result = await ensureBucketAccess(client, { bucket: 'acme', ...pair });

    expect(result).toMatchObject({ bucket: 'acme', accessKeyId: pair.accessKeyId });
    expect(fake.keys.get(pair.accessKeyId)?.secretAccessKey).toBe(pair.secretAccessKey);
    expect(permsOf(fake, 'acme', pair.accessKeyId)).toEqual({
      read: true,
      write: true,
      owner: false,
    });
  });

  it('is idempotent: a second run changes nothing and imports nothing', async () => {
    const { fake, client } = setup();
    const pair = generateKeyPair();
    await ensureBucketAccess(client, { bucket: 'acme', ...pair });
    fake.calls.length = 0;
    await ensureBucketAccess(client, { bucket: 'acme', ...pair });

    const operations = fake.calls.map((call) => call.operation);
    expect(operations).not.toContain('CreateBucket');
    expect(operations).not.toContain('ImportKey');
    expect(operations).not.toContain('DeleteKey');
    expect(fake.buckets.size).toBe(1);
  });

  it('refuses a different secret for an existing key, and leaves the key working', async () => {
    const { fake, client } = setup();
    const first = generateKeyPair();
    await ensureBucketAccess(client, { bucket: 'acme', ...first });
    const other = { ...first, secretAccessKey: generateKeyPair().secretAccessKey };

    await expect(ensureBucketAccess(client, { bucket: 'acme', ...other })).rejects.toMatchObject({
      kind: 'conflict',
      code: 'KeySecretMismatch',
    });
    expect(fake.keys.get(first.accessKeyId)?.secretAccessKey).toBe(first.secretAccessKey);
    expect(permsOf(fake, 'acme', first.accessKeyId)).toEqual({
      read: true,
      write: true,
      owner: false,
    });
    expect(fake.calls.some((call) => call.operation === 'DeleteKey')).toBe(false);
  });

  it('cannot reuse the id of a key that was deleted (Garage never forgets it)', async () => {
    const { client } = setup();
    const pair = generateKeyPair();
    await ensureBucketAccess(client, { bucket: 'acme', ...pair });
    await removeBucketAccess(client, { bucket: 'acme', accessKeyId: pair.accessKeyId });

    await expect(ensureBucketAccess(client, { bucket: 'acme', ...pair })).rejects.toMatchObject({
      kind: 'conflict',
      code: 'KeyAlreadyExists',
    });
  });

  it('takes back owner that the key already held', async () => {
    const { fake, client } = setup();
    const pair = generateKeyPair();
    const { bucketId } = await ensureBucketAccess(client, { bucket: 'acme', ...pair });
    await client.allowBucketKey({
      bucketId,
      accessKeyId: pair.accessKeyId,
      permissions: { owner: true },
    });
    await ensureBucketAccess(client, { bucket: 'acme', ...pair });

    expect(permsOf(fake, 'acme', pair.accessKeyId)?.owner).toBe(false);
  });

  it('honours read-only access and removes write it held before', async () => {
    const { fake, client } = setup();
    const pair = generateKeyPair();
    await ensureBucketAccess(client, { bucket: 'acme', ...pair });
    await ensureBucketAccess(client, { bucket: 'acme', ...pair, permissions: { write: false } });

    expect(permsOf(fake, 'acme', pair.accessKeyId)).toEqual({
      read: true,
      write: false,
      owner: false,
    });
  });

  it('sets quotas only when asked', async () => {
    const { fake, client } = setup();
    const pair = generateKeyPair();
    await ensureBucketAccess(client, { bucket: 'acme', ...pair });
    expect(fake.calls.some((call) => call.operation === 'UpdateBucket')).toBe(false);

    await ensureBucketAccess(client, { bucket: 'acme', ...pair, quotas: { maxSize: 1_000_000 } });
    expect([...fake.buckets.values()][0]?.quotas).toEqual({ maxSize: 1_000_000 });
  });

  it('rejects a key pair Garage would refuse, before any request', async () => {
    const { fake, client } = setup();
    await expect(
      ensureBucketAccess(client, { bucket: 'acme', accessKeyId: 'acme', secretAccessKey: 'nope' }),
    ).rejects.toMatchObject({ kind: 'invalid' });
    expect(fake.calls).toHaveLength(0);
  });

  it('rejects a key with neither read nor write', async () => {
    const { client } = setup();
    await expect(
      ensureBucketAccess(client, {
        bucket: 'acme',
        ...generateKeyPair(),
        permissions: { read: false, write: false },
      }),
    ).rejects.toMatchObject({ kind: 'invalid' });
  });
});

describe('rotateBucketAccess', () => {
  it('gives the new key access, then deletes the previous one', async () => {
    const { fake, client } = setup();
    const first = generateKeyPair();
    await ensureBucketAccess(client, { bucket: 'acme', ...first });
    const next = generateKeyPair();
    fake.calls.length = 0;

    const result = await rotateBucketAccess(client, {
      bucket: 'acme',
      ...next,
      previousAccessKeyId: first.accessKeyId,
    });

    expect(result).toMatchObject({ accessKeyId: next.accessKeyId, previousKeyDeleted: true });
    expect(fake.keys.has(first.accessKeyId)).toBe(false);
    expect(permsOf(fake, 'acme', next.accessKeyId)).toEqual({
      read: true,
      write: true,
      owner: false,
    });
    const operations = fake.calls.map((call) => call.operation);
    expect(operations.indexOf('AllowBucketKey')).toBeLessThan(operations.indexOf('DeleteKey'));
  });

  it('is idempotent once the previous key is gone', async () => {
    const { client } = setup();
    const first = generateKeyPair();
    await ensureBucketAccess(client, { bucket: 'acme', ...first });
    const next = generateKeyPair();
    const input = { bucket: 'acme', ...next, previousAccessKeyId: first.accessKeyId };
    await rotateBucketAccess(client, input);

    expect(await rotateBucketAccess(client, input)).toMatchObject({ previousKeyDeleted: false });
  });

  it('keeps the previous key when the new one cannot be set up', async () => {
    const { fake, client } = setup();
    const first = generateKeyPair();
    await ensureBucketAccess(client, { bucket: 'acme', ...first });

    await expect(
      rotateBucketAccess(client, {
        bucket: 'acme',
        accessKeyId: 'bad',
        secretAccessKey: 'bad',
        previousAccessKeyId: first.accessKeyId,
      }),
    ).rejects.toMatchObject({ kind: 'invalid' });
    expect(fake.keys.has(first.accessKeyId)).toBe(true);
  });

  it('rejects rotating a key onto itself', async () => {
    const { client } = setup();
    const pair = generateKeyPair();
    await expect(
      rotateBucketAccess(client, {
        bucket: 'acme',
        ...pair,
        previousAccessKeyId: pair.accessKeyId,
      }),
    ).rejects.toMatchObject({ kind: 'invalid' });
  });
});

describe('removeBucketAccess', () => {
  it('deletes the key and keeps the bucket by default', async () => {
    const { fake, client } = setup();
    const pair = generateKeyPair();
    await ensureBucketAccess(client, { bucket: 'acme', ...pair });

    const result = await removeBucketAccess(client, {
      bucket: 'acme',
      accessKeyId: pair.accessKeyId,
    });
    expect(result).toEqual({ keyDeleted: true, bucketDeleted: false });
    expect(fake.keys.size).toBe(0);
    expect(fake.buckets.size).toBe(1);
  });

  it('deletes an empty bucket on request', async () => {
    const { fake, client } = setup();
    const pair = generateKeyPair();
    await ensureBucketAccess(client, { bucket: 'acme', ...pair });

    const result = await removeBucketAccess(client, {
      bucket: 'acme',
      accessKeyId: pair.accessKeyId,
      deleteBucket: true,
    });
    expect(result).toEqual({ keyDeleted: true, bucketDeleted: true });
    expect(fake.buckets.size).toBe(0);
  });

  it('fails with conflict, and still revokes the key, when the bucket holds objects', async () => {
    const { fake, client } = setup();
    const pair = generateKeyPair();
    await ensureBucketAccess(client, { bucket: 'acme', ...pair });
    fake.addObjects('acme', 3);

    await expect(
      removeBucketAccess(client, {
        bucket: 'acme',
        accessKeyId: pair.accessKeyId,
        deleteBucket: true,
      }),
    ).rejects.toMatchObject({ kind: 'conflict', code: 'BucketNotEmpty' });
    expect(fake.keys.size).toBe(0);
  });

  it('is idempotent when everything is already gone', async () => {
    const { client } = setup();
    const result = await removeBucketAccess(client, {
      bucket: 'ghost',
      accessKeyId: generateKeyPair().accessKeyId,
      deleteBucket: true,
    });
    expect(result).toEqual({ keyDeleted: false, bucketDeleted: true });
  });
});
