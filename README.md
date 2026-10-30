# Protected Video — Private Tutorial Portal

A single-video tutorial portal with a password-protected admin dashboard, individual customer links, link expiry, revocation, private Vercel Blob video storage and optional external DRM.

## Deployment
- Vercel project: `protected-vedio` (connect this GitHub repository and deploy `main`)
- Framework preset: Other
- Private Vercel Blob store **connected to the same Vercel project**
- Required environment variables in Vercel, not GitHub: `ADMIN_PASSWORD_HASH` (scrypt), `SESSION_SECRET` (random, >=40 characters), `BLOB_READ_WRITE_TOKEN` (automatically set by Blob connection)
- Optional: `ADMIN_USERNAME` (defaults to admin)
- Optional: `VIDEO_MODE=vdocipher`, `VDO_CIPHER_VIDEO_ID`, `VDO_CIPHER_API_SECRET` for commercial DRM
- Test: `npm run check && npm test && npm run build`

Admin URL: `https://<deployment-domain>/admin`. Sign in, upload **one MP4**, then generate a unique private link for each customer. Do not push any video, access token or password to GitHub.

## Important limitations
Plain private MP4 streaming is **not DRM**. IDM, browser tools or screen recording may still capture a stream available to an authorized user. Screen capture can only be resisted on compatible devices through a real DRM solution; external camera filming remains possible. Browser watermark is deterrence, not encryption.

For legitimate paid customer services check Vercel plan terms: Hobby is intended for personal, non-commercial use. The current deployment is for testing and setup.

## Original source
The portal was adapted from the VaultStream Vercel edition. The repository contains no video, user data, API token or password.


## Original-quality portrait/iPhone video (October 2026)

- Upload a **single MP4** through the owner dashboard. The browser sends the file bytes directly to a private Vercel Blob store. **No server-side transcoding, recompression, resolution change, or re-encoding** is performed. A successful upload also checks that the stored byte count matches the local file size.
- Before upload, the admin page previews the original file and displays its native pixel dimensions, orientation, and size (when the browser can read video metadata). Maximum upload size: **500 MB**.
- Customer playback starts in **portrait 9:16** (the requested tutorial format), then automatically adapts to the actual dimensions reported by the HTML video element. It uses `object-fit: contain` so the picture is not cropped or stretched.
- iPhone Safari uses `playsinline`, `webkit-playsinline`, `preload=metadata` and HTTP byte-range requests for normal seeking. Users must tap Play; audio playback does not autoplay.
- **Focus view** fills the phone screen *inside the webpage*, respects safe areas, and leaves the customer watermark visible. Do not confuse this with the iPhone's native video fullscreen button; native fullscreen can hide HTML overlays.
- For widest iPhone compatibility, supply an **MP4 with H.264 (AVC) video and AAC audio**, ideally fast-start for progressive MP4. The website **does not convert** unsupported or HEVC-only videos automatically; if you need to convert a source, do it separately before uploading.
- **Original quality does not mean adaptive streaming**: the browser receives the original bitrate and resolution. Very high-bitrate 4K footage can buffer on slow mobile networks or fail on unsupported phones. A transcoded adaptive stream would require a separate encoding pipeline and could create different quality renditions.
- A protected MP4 stream is **not DRM**: a determined authenticated viewer can still download or record it. Private Vercel Blob delivery also incurs bandwidth and function usage charges; it is best for low-volume personal testing. Check the Vercel plan's commercial use policy before serving paying customers.
