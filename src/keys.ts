import { randomBytes } from 'node:crypto';
import { GarageAdminError } from './errors.js';

/** Garage access key ids are `GK` followed by 24 hex characters. */
const ACCESS_KEY_ID = /^GK[0-9a-f]{24}$/;
/** Garage secret keys are 64 hex characters. */
const SECRET_ACCESS_KEY = /^[0-9a-f]{64}$/;

export type KeyPair = { accessKeyId: string; secretAccessKey: string };

/** A fresh random key pair in the format Garage accepts for `ImportKey`. */
export function generateKeyPair(): KeyPair {
  return {
    accessKeyId: `GK${randomBytes(12).toString('hex')}`,
    secretAccessKey: randomBytes(32).toString('hex'),
  };
}

/** Throws `invalid` when the pair is not in Garage's format, before any request is made. */
export function assertKeyPair(pair: KeyPair, operation: string): void {
  if (!ACCESS_KEY_ID.test(pair.accessKeyId)) {
    throw new GarageAdminError({
      kind: 'invalid',
      operation,
      message: 'garage: access key id must be "GK" followed by 24 lowercase hex characters',
    });
  }
  if (!SECRET_ACCESS_KEY.test(pair.secretAccessKey)) {
    throw new GarageAdminError({
      kind: 'invalid',
      operation,
      message: 'garage: secret access key must be 64 lowercase hex characters',
    });
  }
}
