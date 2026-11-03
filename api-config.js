const PRODUCTION_API_ORIGIN = 'https://api.humanityscharter.org';

export function apiUrl(path) {
  if (typeof path !== 'string' || !path.startsWith('/api/')) {
    throw new TypeError('API path required');
  }
  return `${PRODUCTION_API_ORIGIN}${path}`;
}

export const PROPOSAL_SUBMIT_API_URL = apiUrl('/api/proposals');
export const PROPOSAL_STATUS_API_URL = apiUrl('/api/proposals/status');

// Public browser configuration, intentionally fail-closed until deployment
// supplies the production widget key for humanityscharter.org.
export const TURNSTILE_SITE_KEY = '0x4AAAAAAE7uS8GmS5PiXBO1';
