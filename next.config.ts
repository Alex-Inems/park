import os from "node:os";
import type { NextConfig } from "next";

function lanDevOrigins() {
  const origins = ["192.168.*.*", "10.*.*.*", "*.trycloudflare.com"];
  for (let octet = 16; octet <= 31; octet += 1) origins.push(`172.${octet}.*.*`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.internal) continue;
      if (addr.family === "IPv4" || addr.family === 4) origins.push(addr.address);
    }
  }
  return origins;
}

const nextConfig: NextConfig = {
  /* config options here */
  allowedDevOrigins: lanDevOrigins(),
  cacheComponents: true,
  partialPrefetching: true,
  compress: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Character models never change without a new filename, so let CDNs
        // and browsers keep them for a year.
        source: "/models/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
          { key: "Access-Control-Allow-Origin", value: "*" },
        ],
      },
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
