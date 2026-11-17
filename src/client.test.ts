import { describe, expect, it } from 'vitest';
import { GarageAdminClient } from './client.js';
import { GarageAdminError } from './errors.js';
import { createFakeGarage } from './testing/fake-garage.js';

const ENDPOINT = 'http://garage:3903';

function clientFor(fake = createFakeGarage()) {
  return {
    fake,
    client: new GarageAdminClient({ endpoint: ENDPOINT, token: fake.token, fetch: fake.fetch }),
  };
}

describe('GarageAdminClient', () => {
  it('rejects an invalid endpoint or an empty token before any request', () => {
    expect(() => new GarageAdminClient({ endpoint: 'nope', token: 't' })).toThrow(GarageAdminError);
    expect(() => new GarageAdminClient({ endpoint: ENDPOINT, token: '' })).toThrow(
      GarageAdminError,
    );
  });

  it('sends the bearer token and returns undefined for a missing bucket or key', async () => {
    const { client, fake } = clientFor();
    expect(await client.getBucketByAlias('missing')).toBeUndefined();
    expect(await client.getKey('GK000000000000000000000000')).toBeUndefined();
    expect(fake.calls.map((call) => call.operation)).toEqual(['GetBucketInfo', 'GetKeyInfo']);
  });

  it('maps a wrong token to an auth error without leaking it', async () => {
    const fake = createFakeGarage();
    const client = new GarageAdminClient({
      endpoint: ENDPOINT,
      token: 'wrong-secret',
      fetch: fake.fetch,
    });
    const error = await client.getBucketByAlias('x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GarageAdminError);
    expect(error).toMatchObject({
      kind: 'auth',
      status: 403,
      code: 'AccessDenied',
      operation: 'GetBucketInfo',
    });
    expect(String((error as Error).message)).not.toContain('wrong-secret');
  });

  it('maps an alias that is taken to a conflict', async () => {
    const { client } = clientFor();
    await client.createBucket('acme');
    await expect(client.createBucket('acme')).rejects.toMatchObject({
      kind: 'conflict',
      code: 'BucketAlreadyExists',
    });
  });

  it('reports a connection failure as a network error', async () => {
    const client = new GarageAdminClient({
      endpoint: ENDPOINT,
      token: 't',
      fetch: (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch,
    });
    await expect(client.getBucketByAlias('x')).rejects.toMatchObject({ kind: 'network' });
  });

  it('only asks for the secret key when told to', async () => {
    const { client, fake } = clientFor();
    await client.importKey({
      accessKeyId: 'GKaaaaaaaaaaaaaaaaaaaaaaaa',
      secretAccessKey: 's'.repeat(64),
    });
    expect((await client.getKey('GKaaaaaaaaaaaaaaaaaaaaaaaa'))?.secretAccessKey).toBeNull();
    expect(
      (await client.getKey('GKaaaaaaaaaaaaaaaaaaaaaaaa', { showSecretKey: true }))?.secretAccessKey,
    ).toBe('s'.repeat(64));
    expect(fake.calls.at(-1)?.query).toMatchObject({ showSecretKey: 'true' });
  });
});
