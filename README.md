# Zlatyn Clip Studio

Private-use AI-assisted clipping website with a native FFmpeg backend.

## Deploy a working backend

Use the Render Blueprint to deploy the website and backend from this repository:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/suleimanzlatyn-ai/SuleimanZlatyn-)

The service serves `index.html`, accepts video uploads at `/api/upload`, renders vertical MP4 clips with FFmpeg at `/api/process`, and exposes health status at `/api/health`.

**Important:** the free service uses temporary storage. Download completed clips promptly. A free instance may sleep when idle and can take time to wake up. Very large source files may exceed available memory, disk, or request limits.
