import {
  PROPOSAL_STATUS_API_URL,
  PROPOSAL_SUBMIT_API_URL
} from './api-config.js';

/**
 * Create the 128-bit value used to deduplicate a proposal submission.
 * Keeping this helper injectable makes the browser boundary straightforward
 * to test without weakening the production entropy source.
 */
export function createIdempotencyKey(cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl || typeof cryptoImpl.getRandomValues !== 'function') {
    throw new TypeError('Web Crypto getRandomValues is required');
  }
  const bytes = new Uint8Array(16);
  cryptoImpl.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function failure(reason, extra = {}) {
  return { ok: false, reason, error: reason, ...extra };
}

function responseFailure(response, body) {
  const serverError = body && typeof body.error === 'string' ? body.error : null;
  let reason = 'request_failed';
  if (response.status === 429) reason = 'rate_limited';
  else if (serverError === 'Challenge verification failed') reason = 'challenge_failed';
  else if (response.status === 400) reason = 'validation';
  else if (response.status >= 500) reason = 'unavailable';
  return failure(reason, {
    status: response.status,
    ...(serverError ? { message: serverError } : {})
  });
}

async function responseBody(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function validObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class ProposalClient {
  constructor(fetchImpl = globalThis.fetch, endpoints = {}) {
    this.fetchImpl = fetchImpl;
    this.submitEndpoint = endpoints.submit ?? endpoints.proposals ?? PROPOSAL_SUBMIT_API_URL;
    this.statusEndpoint = endpoints.status ?? endpoints.lookup ?? PROPOSAL_STATUS_API_URL;
    this.idempotencyKey = null;
  }

  reset() {
    this.idempotencyKey = null;
  }

  async submit(payload, turnstileToken) {
    if (this.idempotencyKey === null) this.idempotencyKey = createIdempotencyKey();
    const idempotencyKey = this.idempotencyKey;
    const body = {
      ...(validObject(payload) ? payload : {}),
      turnstileToken
    };

    let response;
    try {
      response = await this.fetchImpl.call(globalThis, this.submitEndpoint, {
        method: 'POST',
        credentials: 'omit',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey
        },
        body: JSON.stringify(body)
      });
    } catch {
      return failure('network');
    }

    const data = await responseBody(response);
    if (!response.ok) return responseFailure(response, data);
    if (!validObject(data) || typeof data.receipt !== 'string' || data.receipt === '') {
      return failure('invalid_response');
    }

    // Rotate only after the server has returned a usable receipt. Any retry
    // after transport or application failure therefore reuses this key.
    this.idempotencyKey = null;
    return { ok: true, ...data };
  }

  async lookup(receipt) {
    let response;
    try {
      response = await this.fetchImpl.call(globalThis, this.statusEndpoint, {
        method: 'POST',
        credentials: 'omit',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ receipt })
      });
    } catch {
      return failure('network');
    }

    const data = await responseBody(response);
    if (!response.ok) return responseFailure(response, data);
    if (!validObject(data)) return failure('invalid_response');
    return { ok: true, ...data };
  }
}
