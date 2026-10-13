# syntax=docker/dockerfile:1

# Reflasher image server. Serves OS images plus dynamically-built reflash
# scripts to Raspberry Pis on the LAN, and an admin UI for managing them.

# --- build the Vue admin UI ---
FROM node:22-alpine AS ui
WORKDIR /ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

# --- runtime: the server itself has zero dependencies ---
FROM node:22-alpine

# App code lives in /app, kept separate from the image directory so a bind
# mount at /data can't shadow the server or reflash.sh. reflash.sh is
# discovered by serve-image.js via its __dirname fallback (/app/reflash.sh).
WORKDIR /app
COPY serve-image.js reflash.sh ./
COPY --from=ui /ui/dist ./ui/dist

# Images, archive/ and scripts.json live here. Mount it read-write so the
# admin UI can upload, archive and delete images.
WORKDIR /data

# Default listen port. Override with `--port N` and publish the matching port.
EXPOSE 8080

#   docker run --rm --init -p 8080:8080 -v "$PWD/images:/data" reflasher
ENTRYPOINT ["node", "/app/serve-image.js"]
