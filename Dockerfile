# syntax=docker/dockerfile:1

# Reflasher image server. Serves an OS image plus a dynamically-built
# reflash.sh to Raspberry Pis on the LAN. The server has zero runtime
# dependencies, so a tiny Node base is all it needs.
FROM node:22-alpine

# App code lives in /app, kept separate from the served image directory so a
# bind mount at /data can't shadow the server or reflash.sh. reflash.sh is
# discovered by serve-image.js via its __dirname fallback (/app/reflash.sh).
WORKDIR /app
COPY serve-image.js reflash.sh ./

# Images are served from the working directory (the server's cwd == ROOT).
# Mount the directory holding your .img.xz here at run time.
WORKDIR /data

# Default listen port. Override with `--port N` and publish the matching port.
EXPOSE 8080

# The image filename (and any flags) are passed as `docker run` arguments, e.g.
#   docker run --rm --init -p 8080:8080 -v "$PWD:/data:ro" reflasher rpi.img.xz
ENTRYPOINT ["node", "/app/serve-image.js"]
