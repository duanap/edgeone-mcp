import { listAuthorizedZones } from './edgeone-client.mjs';

export async function verifyEdgeOne(client) {
  const zones = await listAuthorizedZones(client);
  return {
    zoneCount: zones.length,
    zones: zones.map(({ ZoneId, ZoneName, Status }) => ({ ZoneId, ZoneName, ...(Status ? { Status } : {}) })),
  };
}
