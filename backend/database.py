import aiosqlite
import json
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).parent / "data" / "history.db"

async def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(str(DB_PATH)) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                raw_data TEXT NOT NULL
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS stock_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                category TEXT NOT NULL,
                item_key TEXT NOT NULL,
                item_name TEXT NOT NULL,
                quantity INTEGER NOT NULL,
                rarity TEXT
            )
        """)
        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_stock_history_time
            ON stock_history(timestamp)
        """)
        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_stock_history_item
            ON stock_history(item_key)
        """)
        await db.commit()

async def save_snapshot(raw_data: dict):
    async with aiosqlite.connect(str(DB_PATH)) as db:
        ts = datetime.utcnow().isoformat() + "Z"
        await db.execute(
            "INSERT INTO snapshots (timestamp, raw_data) VALUES (?, ?)",
            (ts, json.dumps(raw_data))
        )
        for cat in raw_data.get("stock", []):
            for item in cat.get("items", []):
                await db.execute(
                    """INSERT INTO stock_history
                       (timestamp, category, item_key, item_name, quantity, rarity)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (ts, cat["category"], item["key"], item["name"],
                     item["quantity"], item.get("rarity"))
                )
        await db.commit()

async def get_history(limit: int = 100, skip: int = 0):
    async with aiosqlite.connect(str(DB_PATH)) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM stock_history ORDER BY timestamp DESC LIMIT ? OFFSET ?",
            (limit, skip)
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

async def get_item_history(item_key: str, limit: int = 1008):
    async with aiosqlite.connect(str(DB_PATH)) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM stock_history WHERE item_key = ? ORDER BY timestamp DESC LIMIT ?",
            (item_key, limit)
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

async def get_snapshot(id: int):
    async with aiosqlite.connect(str(DB_PATH)) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM snapshots WHERE id = ?", (id,)
        )
        row = await cursor.fetchone()
        return dict(row) if row else None
