import asyncio
import json
import logging
from contextlib import asynccontextmanager

from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse

from backend.database import init_db, get_history
from backend.poller import poll_loop

HERE = Path(__file__).parent

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")
logger = logging.getLogger("main")

latest_data = {}
websockets: list[WebSocket] = []

@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    logger.info("Database initialized")
    task = asyncio.create_task(poll_loop(broadcast_update))
    yield
    task.cancel()
    for ws in websockets:
        await ws.close()

app = FastAPI(title="GAG2 Live Tracker", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

async def broadcast_update(data: dict):
    global latest_data
    latest_data = data
    msg = json.dumps(data, default=str)
    dead = []
    for ws in websockets:
        try:
            await ws.send_text(msg)
        except Exception:
            dead.append(ws)
    for ws in dead:
        websockets.remove(ws)

@app.get("/")
async def get_dashboard():
    html = (HERE / "dashboard.html").read_text(encoding="utf-8")
    return HTMLResponse(html)

@app.get("/api/stock")
async def get_stock():
    return latest_data.get("stock", [])

@app.get("/api/weather")
async def get_weather():
    return latest_data.get("weather")

@app.get("/api/sell")
async def get_sell():
    return latest_data.get("sell")

@app.get("/api/live")
async def get_live():
    return latest_data

@app.get("/api/history")
async def get_history_endpoint(limit: int = 100, skip: int = 0):
    rows = await get_history(limit, skip)
    return rows

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    websockets.append(ws)
    if latest_data:
        await ws.send_text(json.dumps(latest_data, default=str))
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        websockets.remove(ws)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
