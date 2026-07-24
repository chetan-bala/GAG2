import asyncio
import logging
import httpx
from datetime import datetime
from database import save_snapshot

logger = logging.getLogger("poller")

API_URL = "https://api.gag2.gg/api/live"
POLL_INTERVAL = 15
last_checksum = None

def checksum(data: dict) -> str:
    stock = data.get("stock", [])
    parts = []
    for cat in stock:
        for item in cat.get("items", []):
            parts.append(f"{item['key']}:{item['quantity']}")
    weather = data.get("weather", {})
    current = weather.get("current")
    if current:
        parts.append(f"weather:{current.get('type')}")
    return ",".join(parts)

async def poll_loop(changed_callback):
    global last_checksum
    retry_delay = 1
    async with httpx.AsyncClient(timeout=10) as client:
        while True:
            try:
                resp = await client.get(API_URL)
                resp.raise_for_status()
                data = resp.json()
                cs = checksum(data)
                now = datetime.utcnow().isoformat() + "Z"
                data["fetchedAt"] = now

                if cs != last_checksum:
                    logger.info("Data changed — saving snapshot")
                    await save_snapshot(data)
                    last_checksum = cs
                    await changed_callback(data)
                else:
                    logger.debug("No change")

                retry_delay = 1
                await asyncio.sleep(POLL_INTERVAL)

            except httpx.HTTPStatusError as e:
                logger.error(f"HTTP error: {e.response.status_code}")
                await asyncio.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, 60)

            except httpx.RequestError as e:
                logger.error(f"Request failed: {e}")
                await asyncio.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, 60)

            except Exception as e:
                logger.exception(f"Unexpected error: {e}")
                await asyncio.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, 60)
