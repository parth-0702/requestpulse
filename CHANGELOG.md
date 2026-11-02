# Changelog

## 1.0.0

First public release.

- Load-test one HTTP endpoint (GET or HEAD) at a fixed rate for a fixed duration.
- Describe traffic as requests per second, or as a total number of requests spread over a duration.
- Targets for p95 response time and error rate, with a pass/fail verdict.
- Dashboard with throughput and response-time charts, percentiles, status codes and plain-language findings.
- Start and stop controls; stopped tests keep their partial results.
- Results saved locally as JSON; side-by-side comparison of two saved runs.
- Permission confirmation required for any non-local URL.
- Uses k6 (installed separately) as the traffic generator.
