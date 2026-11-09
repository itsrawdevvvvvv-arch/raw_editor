FROM mcr.microsoft.com/playwright:v1.49.1-jammy
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-open-sans \
    && rm -rf /var/lib/apt/lists/*
COPY fonts/ /usr/local/share/fonts/raw/
RUN fc-cache -f
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=7860 NODE_ENV=production WORK_DIR=/tmp/raw_edit_jobs
RUN mkdir -p /tmp/raw_edit_jobs && chown -R pwuser:pwuser /app /tmp/raw_edit_jobs
USER pwuser
EXPOSE 7860
CMD ["node", "server.js"]
