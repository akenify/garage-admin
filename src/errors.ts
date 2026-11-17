export type GarageAdminErrorKind =
  /** The request never got an answer: DNS, connection refused, timeout. */
  | 'network'
  /** 401 or 403: the admin token is missing, wrong or lacks the permission. */
  | 'auth'
  /** 404: the bucket or key does not exist. */
  | 'not_found'
  /** 409: the alias is taken, the key exists or the bucket is not empty. */
  | 'conflict'
  /** 400 and any other status: Garage rejected the request or failed. */
  | 'service'
  /** Invalid input caught before any request was made. */
  | 'invalid';

/**
 * Every failure of this package. Never carries the admin token, key secrets or request bodies:
 * only the operation, the HTTP status and Garage's own error code.
 */
export class GarageAdminError extends Error {
  readonly kind: GarageAdminErrorKind;
  readonly operation: string;
  readonly status?: number;
  /** Garage's error code, for example `NoSuchBucket` or `BucketNotEmpty`. */
  readonly code?: string;

  constructor(input: {
    kind: GarageAdminErrorKind;
    operation: string;
    message: string;
    status?: number;
    code?: string;
  }) {
    super(input.message);
    this.name = 'GarageAdminError';
    this.kind = input.kind;
    this.operation = input.operation;
    if (input.status !== undefined) this.status = input.status;
    if (input.code !== undefined) this.code = input.code;
  }
}

export function kindForStatus(status: number): GarageAdminErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  return 'service';
}
