export {
  ensureBucketAccess,
  removeBucketAccess,
  rotateBucketAccess,
  type EnsureBucketAccessInput,
  type EnsureBucketAccessResult,
  type RemoveBucketAccessInput,
  type RemoveBucketAccessResult,
  type RotateBucketAccessInput,
  type RotateBucketAccessResult,
} from './access.js';
export {
  GarageAdminClient,
  type BucketInfo,
  type BucketKeyPermissions,
  type BucketQuotas,
  type GarageAdminConfig,
  type KeyInfo,
} from './client.js';
export { GarageAdminError, type GarageAdminErrorKind } from './errors.js';
export { generateKeyPair, type KeyPair } from './keys.js';
