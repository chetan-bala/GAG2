from pydantic import BaseModel
from datetime import datetime
from typing import Optional

class StockItem(BaseModel):
    key: str
    name: str
    rarity: str
    emoji: str
    quantity: int

class StockCategory(BaseModel):
    category: str
    items: list[StockItem]
    restockedAt: Optional[datetime] = None
    nextRestockAt: Optional[datetime] = None

class SellEntry(BaseModel):
    key: str
    name: str
    multiplier: float
    tier: str

class SellData(BaseModel):
    entries: list[SellEntry]
    boundary: int
    nextRefreshUnix: int
    cycleSeconds: int

class WeatherCurrent(BaseModel):
    type: str
    name: str
    emoji: str
    color: str
    blurb: str
    boost: Optional[str] = None
    startsAt: datetime
    endsAt: datetime

class UpcomingMoon(BaseModel):
    name: str
    boundary: int

class RecentWeather(BaseModel):
    key: str
    name: str
    lastSeenAt: datetime

class WeatherData(BaseModel):
    current: Optional[WeatherCurrent] = None
    upcomingMoons: list[UpcomingMoon]
    recent: list[RecentWeather]

class LiveData(BaseModel):
    stock: list[StockCategory]
    sell: Optional[SellData] = None
    weather: Optional[WeatherData] = None
    fetchedAt: datetime

class StockSnapshot(BaseModel):
    id: int
    timestamp: datetime
    raw_data: LiveData
