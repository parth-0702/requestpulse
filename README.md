# RequestPulse — Load Testing for VS Code

Send controlled traffic to a **local or deployed HTTP endpoint** (localhost, Vercel, Render, any URL you own) and see how it holds up — response times, errors and throughput — without leaving VS Code. Save runs, change your app, run again, and compare **before vs after**.

## Requirements

RequestPulse uses [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/), a free open-source load-testing tool, to generate the traffic. Install it once:

| OS | Command |
| --- | --- |
| Windows | `winget install k6 --source winget`, or `choco install k6`, or download the `.msi` / `.zip` from the [k6 releases](https://github.com/grafana/k6/releases/latest) |
| macOS | `brew install k6` |
| Linux | see the [k6 install guide](https://grafana.com/docs/k6/latest/set-up/install-k6/) |

Restart VS Code afterwards so it picks up the new PATH. If k6 lives somewhere unusual, set `requestpulse.k6Path` in Settings. Run **RequestPulse: Check k6 Installation** to verify.

## Use it

1. Start your application (or have a deployed URL ready).
2. Command Palette → **RequestPulse: Open Dashboard**.
3. Enter the URL, then choose traffic either as **requests per second** (e.g. 20/s for 5 min) or **total requests over a duration** (e.g. 6,000 over 5 min).
4. Set your targets: p95 response time and maximum error rate.
5. **Start test.** Stop at any time; partial results are kept.
6. Read the report, then use **History & compare** to put two runs side by side.

## What you get

- Requests sent and the traffic **actually achieved** (your computer may not keep up with high targets — the report says so)
- Median, p90, p95, p99 and max response time
- Status-code breakdown, timeouts and connection errors
- Throughput and response-time charts over the test
- Pass/fail against your targets, plus plain-language findings
- Saved history with before/after comparison

## Limits of this version

- One `GET` or `HEAD` endpoint per test (no login or multi-step journeys yet)
- Fixed rate for a fixed duration (no ramp-up yet)
- Up to 500 requests/second, 100,000 requests and 1 hour per test
- Results are post-test (no live streaming charts yet)

## Read the numbers carefully

- Requests are not users. One visitor can trigger many requests.
- Traffic comes **from your computer and network**, so results include that path. If the app and k6 run on the same machine they compete for CPU.
- A URL does not expose server CPU or memory.
- One test is not the site's absolute capacity. Raise the rate across several runs to find where your targets stop being met.
- Free tiers (Vercel, Render) have usage limits, and Render free services sleep, so the first requests can be slow.

## Responsible use

Only test systems **you own or have permission to test**. Load tests add real traffic and may breach a host's terms or use up quotas. For any non-local URL, RequestPulse asks you to confirm permission first.

## Privacy

Everything stays on your computer. Results are saved as JSON files in the extension's local storage folder (**RequestPulse: Open Saved Reports Folder**). RequestPulse sends no telemetry and contacts no server other than the URL you choose to test. k6's own usage reporting is disabled.

## Platforms

Automated tests run on Linux with k6 1.6. The dashboard and k6 detection have also been checked on Windows 11. macOS uses the same code paths but is untested — please report issues.

## License

MIT
