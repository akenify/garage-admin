# @akenify/garage-admin

A typed TypeScript client for the [Garage](https://garagehq.deuxfleurs.fr) v2 admin API, with two helpers that give an application its own S3 bucket and credentials:

- `ensureBucketAccess` creates a bucket and a key, and lets the key read and write that bucket only.
- `rotateBucketAccess` moves the application to a new key and then deletes the old one.
- `removeBucketAccess` revokes the key and, if asked, deletes the bucket.

Both are idempotent. They are built for multi-tenant hosting, where every tenant gets one bucket and one key, but they work for any application that needs the same.

It has no runtime dependencies. It uses `fetch` and `node:crypto`, so it needs Node 20 or later.

## Usage

```ts
import {
  GarageAdminClient,
  ensureBucketAccess,
  generateKeyPair,
  removeBucketAccess,
} from '@akenify/garage-admin';

const client = new GarageAdminClient({
  endpoint: 'http://garage:3903', // the admin API, not the S3 port
  token: process.env.GARAGE_ADMIN_TOKEN!,
});

// Store the key pair yourself: Garage returns the secret only for keys it generated.
const { accessKeyId, secretAccessKey } = generateKeyPair();

await ensureBucketAccess(client, { bucket: 'acme', accessKeyId, secretAccessKey });
// The application now uses accessKeyId and secretAccessKey against the S3 API,
// with path-style addressing, on bucket "acme".

await removeBucketAccess(client, { bucket: 'acme', accessKeyId, deleteBucket: true });
```

## What `ensureBucketAccess` guarantees

- **One bucket, one key.** The key has `read` and `write` on that bucket and is never `owner`. An owner can delete the bucket and change its permissions. If the key already holds more than you asked for, the extra permissions are taken away.
- **Your credentials.** Garage lets you import a key with a chosen id and secret. The id must be `GK` followed by 24 lowercase hex characters, and the secret 64 lowercase hex characters. `generateKeyPair()` makes a valid pair, and anything else is rejected before any request is made.
- **Never deletes a key.** If the key exists with a different secret, it fails with a `conflict` error (`KeySecretMismatch`). Garage cannot change a key's secret, and it never accepts a deleted key id again, so there is no safe way to "replace" a key under the same id.
- **Rotation uses a new key id.** `rotateBucketAccess` imports the new key and grants it access first, then deletes the previous key, so the application always has a working key. Keep the key id with the secret, because it changes on every rotation.
- **Quotas.** Pass `quotas: { maxSize, maxObjects }` to cap the bucket. Leave it out to keep the current quotas.

## Differences from MinIO and AWS S3

- **No users or policies.** Access is per key and per bucket, with three flags: read, write, owner.
- **No object versioning.** Garage does not support it.
- **Only empty buckets are deleted.** `removeBucketAccess({ deleteBucket: true })` fails with a `conflict` error (`BucketNotEmpty`) while the bucket holds objects. The key is revoked first, so its credentials stop working either way. Empty the bucket with an S3 client, then call it again.

## Errors

Every failure is a `GarageAdminError` with a `kind`: `network`, `auth`, `not_found`, `conflict`, `service` or `invalid`. It also carries the operation, the HTTP status and Garage's error code. It never contains the admin token or any secret.

## Client

`GarageAdminClient` wraps the operations the helpers need: `getBucketByAlias`, `getBucketById`, `createBucket`, `deleteBucket`, `updateBucketQuotas`, `getKey`, `listKeys`, `importKey`, `deleteKey`, `allowBucketKey` and `denyBucketKey`. It is not a complete client for the admin API.

It targets the v2 API, checked against the Garage 2.5 specification and written for Garage 2.x.

## Development

```
pnpm install
pnpm typecheck
pnpm test
pnpm format:check
pnpm build
```

The tests run against an in-memory fake of the admin API, which enforces the rules the helpers rely on (unique aliases, no re-import of a deleted key, only empty buckets can be deleted). It is exported for your own tests:

```ts
import { createFakeGarage } from '@akenify/garage-admin/testing';

const fake = createFakeGarage();
const client = new GarageAdminClient({
  endpoint: 'http://garage:3903',
  token: fake.token,
  fetch: fake.fetch,
});
```

## License

MIT
