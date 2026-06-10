# logorrhea — Logstalgia-style live traffic visualizer.
#
# A Bun/Elysia backend tails Traefik access logs (via stern) and streams
# parsed request events over a WebSocket to a React + PixiJS frontend.

# 1. Build the React/Vite frontend.
FROM oven/bun:1.3.14 AS web
WORKDIR /web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/ ./
RUN bun run build

# 2. Runtime: Bun server + stern, serving the built assets.
FROM oven/bun:1.3.14 AS runtime

ARG STERN_VERSION=1.34.0
# TARGETARCH is provided by BuildKit (amd64 for the cluster, arm64 for local).
ARG TARGETARCH=amd64

ENV NODE_ENV=production
WORKDIR /opt/logorrhea

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# stern: multi-pod log tailer for the Traefik access logs. The tarball is
# verified against the checksums.txt published with the release.
RUN cd /tmp \
    && curl -fsSLO \
        "https://github.com/stern/stern/releases/download/v${STERN_VERSION}/stern_${STERN_VERSION}_linux_${TARGETARCH}.tar.gz" \
    && curl -fsSL \
        "https://github.com/stern/stern/releases/download/v${STERN_VERSION}/checksums.txt" \
        -o checksums.txt \
    && grep " stern_${STERN_VERSION}_linux_${TARGETARCH}\.tar\.gz\$" checksums.txt | sha256sum -c - \
    && tar -xzf "stern_${STERN_VERSION}_linux_${TARGETARCH}.tar.gz" -C /usr/local/bin stern \
    && chmod +x /usr/local/bin/stern \
    && rm "stern_${STERN_VERSION}_linux_${TARGETARCH}.tar.gz" checksums.txt

COPY server/package.json server/bun.lock ./
RUN bun install --frozen-lockfile --production

COPY server/*.ts ./
COPY --from=web /web/dist ./public

RUN useradd --create-home --uid 10001 logorrhea && chown -R logorrhea /opt/logorrhea
USER logorrhea

EXPOSE 8080
CMD ["bun", "index.ts"]
