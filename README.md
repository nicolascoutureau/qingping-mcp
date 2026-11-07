# qingping-mcp

[MCP](https://modelcontextprotocol.io) server for **Qingping** air quality monitors (Air Monitor CGS1, Air Monitor 2, Lite, thermometers…), through the [official cloud Open API](https://developer.qingping.co/cloud-to-cloud/open-apis).

Ask Claude (or any MCP client): "what's the CO₂ in the bedroom?", "did CO₂ go above 1000 ppm last night?", "show me the PM2.5 curve over 7 days".

## Tools

| Tool | What it does |
|---|---|
| `qingping_current` | Latest readings (CO₂, PM2.5, PM10, tVOC, temperature, humidity, battery…) with a plain-language level (good / high — ventilate…), the age of the reading and a warning when it is stale |
| `qingping_history` | History over a period: min / max / average per metric, time of the peak, minutes above thresholds (CO₂ > 1000 / 1500 ppm, PM2.5 > 15 / 35, humidity > 60 / 70 %), share of the period actually covered, optional series to draw a chart |
| `qingping_alerts` | Triggered alerts (thresholds set in the app) |
| `qingping_set_intervals` | Measurement and cloud upload intervals |

## Setup

1. On [developer.qingping.co](https://developer.qingping.co), log in with the Qingping+ / Qingping IoT account that owns your sensors, then **Access management** → copy the **App Key** and **App Secret**.
2. Build the server:

   ```sh
   git clone https://github.com/nicolascoutureau/qingping-mcp.git
   cd qingping-mcp
   npm install && npm run build
   ```

3. Put the keys in a `.env` file at the project root (it is git-ignored):

   ```sh
   QINGPING_APP_KEY=...
   QINGPING_APP_SECRET=...
   ```

   or pass them as environment variables.
4. Add the server to Claude Code:

   ```sh
   claude mcp add -s user qingping -- node /path/to/qingping-mcp/dist/index.js
   ```

## Troubleshooting

- **The device is listed but has no reading at all** (`readingAt: null`, empty history, "No historical data" in the app): the sensor is not reaching the Qingping cloud. Check the date and time on the sensor's screen: if they are wrong (e.g. 2015), it is connected to Wi-Fi but has no Internet access. Reset its Wi-Fi and pair it again in the app (2.4 GHz network). The app's "Now" values may arrive over Bluetooth and hide the problem.
- **Freshness**: the cloud only knows what the sensor uploads (every 15 min by default). `qingping_set_intervals` can bring it down to a few minutes for a plugged-in device.
- **tVOC**: the API returns it in ppb (the app shows mg/m³).

## Development

```sh
npm test          # tests (simulated API)
npm run inspect   # MCP Inspector
```

## License

MIT
