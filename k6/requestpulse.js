// k6 script used by the RequestPulse extension. All settings arrive as environment variables set by
// the extension (never interpolated into code), so nothing the user types is ever executed as script.
import http from 'k6/http';

const url = __ENV.RP_URL;
const method = __ENV.RP_METHOD === 'HEAD' ? 'HEAD' : 'GET';
const timeoutSec = parseInt(__ENV.RP_TIMEOUT_SEC, 10) || 10;

export const options = {
  discardResponseBodies: true,
  userAgent: 'RequestPulse/0.1 (k6)',
  scenarios: {
    requestpulse: {
      executor: 'constant-arrival-rate',
      rate: parseInt(__ENV.RP_RATE, 10),
      timeUnit: __ENV.RP_TIME_UNIT || '1s',
      duration: parseInt(__ENV.RP_DURATION_SEC, 10) + 's',
      preAllocatedVUs: parseInt(__ENV.RP_PREALLOC_VUS, 10) || 1,
      maxVUs: parseInt(__ENV.RP_MAX_VUS, 10) || 50,
      gracefulStop: timeoutSec + 2 + 's',
    },
  },
};

export default function () {
  // One request per iteration, redirects off, so "iterations per second" == "requests per second".
  http.request(method, url, null, { redirects: 0, timeout: timeoutSec + 's' });
}
