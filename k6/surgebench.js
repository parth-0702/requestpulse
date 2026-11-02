// k6 script used by the SurgeBench extension. All settings arrive as environment variables set by
// the extension (never interpolated into code), so nothing the user types is ever executed as script.
import http from 'k6/http';

const url = __ENV.SB_URL;
const method = __ENV.SB_METHOD === 'HEAD' ? 'HEAD' : 'GET';
const timeoutSec = parseInt(__ENV.SB_TIMEOUT_SEC, 10) || 10;

export const options = {
  discardResponseBodies: true,
  userAgent: 'SurgeBench/0.1 (k6)',
  scenarios: {
    surgebench: {
      executor: 'constant-arrival-rate',
      rate: parseInt(__ENV.SB_RATE, 10),
      timeUnit: __ENV.SB_TIME_UNIT || '1s',
      duration: parseInt(__ENV.SB_DURATION_SEC, 10) + 's',
      preAllocatedVUs: parseInt(__ENV.SB_PREALLOC_VUS, 10) || 1,
      maxVUs: parseInt(__ENV.SB_MAX_VUS, 10) || 50,
      gracefulStop: timeoutSec + 2 + 's',
    },
  },
};

export default function () {
  // One request per iteration, redirects off, so "iterations per second" == "requests per second".
  http.request(method, url, null, { redirects: 0, timeout: timeoutSec + 's' });
}
