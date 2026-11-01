### Option 3: Vercel Serverless
The repository includes pre-configured [`vercel.json`](./vercel.json) and serverless handlers in [`api/`](./api/):
1. Import repository to Vercel.
2. In Project Settings > Environment Variables, add one of these:
   - `NEMOTRON_API_KEY`: `nvapi-YOUR_KEY_HERE`
   - `NVIDIA_API_KEY`: `nvapi-YOUR_KEY_HERE`
3. Redeploy the project.
4. Confirm the API key is a real NVIDIA key from [build.nvidia.com](https://build.nvidia.com/) and that it is not expired.

Do not rely on `config.json` in Vercel. That file is for local development only; Vercel reads environment variables from the project settings.
