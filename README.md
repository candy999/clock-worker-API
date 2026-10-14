# clock-api

time.candy.moe 的對時 API（Cloudflare Worker）。

## 端點

| 端點 | 說明 |
|---|---|
| `GET /api/time` | 回傳 `{ serverTime }`（Cloudflare 時鐘，與 NTP 同步）。任何網域都可呼叫，給售票頁懸浮時鐘用。 |
| `GET /api/proxy-time?url=<任何網址>` | 用「秒邊界夾擠法」量出目標網站時鐘與 Worker 時鐘的差，約需 8 秒。回傳 `{ offset, uncertainty, samples }`，`offset` = 目標網站時間 − Worker 時間。只打網域（`shopee.tw`）也可以。 |

## 2026-10 修正

- **秒邊界夾擠法**：舊版直接拿 `Date` 標頭當時間，但它只精確到秒且被捨去，平均慢 500ms。新版每次都瞄準「預測中的整秒交界」送 HEAD，用 `[D − t2, D + 1000 − t1]` 的交集逐步縮小範圍，最後收斂到約 ±RTT/2。
- **任何網址都能探測**（售票、蝦皮、日韓網站都可以），只擋本機與內網位址；呼叫端仍只限 `time.candy.moe`（`ALLOWED_ORIGINS`）。
- **快取防護**：首頁、使用者給的網址、不存在的隨機路徑三種探測網址輪流試，挑第一個「沒被 CDN 快取」的來用；帶 `Age` 的回應一律丟棄。如果整個網站都是快取靜態頁（例如某些 S3 + CloudFront 架構），會回傳錯誤，請改填該網站購票或 API 用的網域。
- 每次探測 6 秒逾時，單次失敗會跳過。
- **`Timing-Allow-Origin`**：前端可以用 Resource Timing 把 DNS、TCP、TLS 與排隊時間從 RTT 中扣掉。
- **`Cache-Control: no-store`**。
- 保留舊欄位 `targetTime`、`rtt`，舊版前端仍可運作。

## 部署

先部署 API，再部署前端（新版前端需要新的 `offset` 欄位）。

```
npm install
npx wrangler deploy
```
