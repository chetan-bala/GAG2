import { useState, useEffect, useCallback, useRef } from 'react'
import { ArrowPathIcon, SunIcon, MoonIcon } from '@heroicons/react/24/solid'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
const RARITY_COLORS = {
  common: '#94a3b8', uncommon: '#34d399', rare: '#38bdf8',
  super: '#38bdf8', epic: '#a78bfa', legendary: '#fbbf24',
  mythic: '#e879f9', divine: '#22d3ee',
}
const CATEGORIES = {
  seed: { label: 'Seed Shop', color: '#10b981', icon: '🌱' },
  gear: { label: 'Gear Shop', color: '#0ea5e9', icon: '🔧' },
  crate: { label: 'Crates', color: '#f97316', icon: '📦' },
}

function Countdown({ target }) {
  const [text, setText] = useState('')
  useEffect(() => {
    function tick() {
      if (!target) { setText('—'); return }
      const ms = new Date(target).getTime() - Date.now()
      if (ms <= 0) { setText('Now'); return }
      const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60)
      setText(h > 0 ? `${h}h ${m % 60}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [target])
  return <span>{text}</span>
}

export default function Home({ dark, setDark }) {
  const [data, setData] = useState(null)
  const [connected, setConnected] = useState(false)
  const [search, setSearch] = useState('')
  const [filterCat, setFilterCat] = useState('all')
  const [countdown, setCountdown] = useState(15)
  const [history, setHistory] = useState([])
  const [notifications, setNotifications] = useState(false)
  const wsRef = useRef(null)
  const notifyRef = useRef(null)

  // WebSocket
  useEffect(() => {
    let ws
    function connect() {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const host = API.replace(/^https?:\/\//, '')
      ws = new WebSocket(`${proto}://${host}/ws`)
      ws.onopen = () => { setConnected(true) }
      ws.onmessage = (e) => {
        try {
          const d = JSON.parse(e.data)
          setData(d)
          setCountdown(15)
        } catch {}
      }
      ws.onclose = () => {
        setConnected(false)
        setTimeout(connect, 2000)
      }
      ws.onerror = () => ws.close()
    }
    connect()
    wsRef.current = { connect }
    return () => ws?.close()
  }, [])

  // Countdown timer
  useEffect(() => {
    if (countdown <= 0) return
    const id = setTimeout(() => setCountdown(c => c - 1), 1000)
    return () => clearTimeout(id)
  }, [countdown])

  // Notification permission
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }
  }, [])

  // Stock change notifications
  const prevRef = useRef('')
  useEffect(() => {
    if (!data?.stock || !notifications) return
    const cs = JSON.stringify(data.stock.map(c => c.items.map(i => ({ k: i.key, q: i.quantity }))))
    if (prevRef.current && prevRef.current !== cs && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('GAG2 Stock Changed!', { body: 'Check the dashboard for details.' })
      // Play a sound
      if (notifyRef.current) notifyRef.current.play().catch(() => {})
    }
    prevRef.current = cs
  }, [data, notifications])

  // Fetch history
  const fetchHistory = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/history?limit=50`)
      setHistory(await r.json())
    } catch {}
  }, [])
  useEffect(() => { fetchHistory() }, [fetchHistory])

  // Prepare stock chart data
  const chartData = {}
  const seen = new Set()
  for (const row of history.slice().reverse()) {
    if (!seen.has(row.item_key)) {
      seen.add(row.item_key)
      if (!chartData[row.category]) chartData[row.category] = []
      chartData[row.category].push({
        name: row.item_name,
        quantity: row.quantity,
        rarity: row.rarity,
      })
    }
  }

  // Filter items
  const filteredStock = data?.stock?.map(cat => ({
    ...cat,
    items: cat.items.filter(i =>
      (filterCat === 'all' || cat.category === filterCat) &&
      (i.name.toLowerCase().includes(search.toLowerCase()) ||
       i.rarity?.toLowerCase().includes(search.toLowerCase()))
    )
  })).filter(c => c.items.length > 0) || []

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="bg-surface border-b border-border px-4 sm:px-6 py-3 flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-extrabold tracking-tight">
            <span className="bg-gradient-to-r from-seed via-gear to-crate bg-clip-text text-transparent">GAG2</span>
            {' '}Live Tracker
          </h1>
          <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1 rounded-full ${
            connected ? 'bg-seed/10 text-seed border border-seed/25' : 'bg-red-500/10 text-red-400 border border-red-500/25'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-seed live-dot' : 'bg-red-400'}`} />
            {connected ? 'LIVE' : 'OFFLINE'}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {countdown > 0 && (
            <span className="text-xs text-muted">Refresh in {countdown}s</span>
          )}
          <button
            onClick={() => setNotifications(!notifications)}
            className={`text-xs px-3 py-1.5 rounded-lg border transition ${
              notifications ? 'bg-seed/10 border-seed/30 text-seed' : 'bg-transparent border-border text-muted'
            }`}
          >
            {notifications ? '🔔 On' : '🔕 Off'}
          </button>
          <button
            onClick={() => setDark(!dark)}
            className="p-1.5 rounded-lg hover:bg-white/5 text-muted"
          >
            {dark ? <SunIcon className="w-4 h-4" /> : <MoonIcon className="w-4 h-4" />}
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-6xl mx-auto w-full px-4 py-6 space-y-6">
        {/* Weather bar */}
        {data?.weather?.current && (
          <div className="bg-surface border border-border rounded-xl px-4 py-3 flex items-center gap-3 fade-in">
            <span className="text-2xl">{data.weather.current.emoji}</span>
            <div className="flex-1">
              <div className="font-semibold text-sm">{data.weather.current.name}</div>
              <div className="text-xs text-muted">{data.weather.current.blurb}</div>
            </div>
            <div className="text-xs text-right text-muted">
              <div>Ends <Countdown target={data.weather.current.endsAt} /></div>
            </div>
          </div>
        )}

        {/* Upcoming Moons */}
        {data?.weather?.upcomingMoons?.length > 0 && (
          <div className="bg-surface border border-border rounded-xl p-4">
            <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-3">Upcoming Moons</h3>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {data.weather.upcomingMoons.slice(0, 8).map((m, i) => (
                <div key={i} className="flex-shrink-0 bg-white/[0.03] rounded-lg px-3 py-2 text-center min-w-[90px]">
                  <div className="text-lg">{m.name.includes('Rainbow') ? '🌈' : m.name.includes('Mega') ? '🟣' : m.name.includes('Blood') ? '🔴' : m.name.includes('Gold') ? '🟡' : '🌙'}</div>
                  <div className="text-[10px] text-muted mt-1">
                    <Countdown target={new Date(m.boundary * 1000).toISOString()} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Search & Filter */}
        <div className="flex gap-2 flex-wrap">
          <input
            type="text"
            placeholder="Search items..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="flex-1 min-w-[200px] bg-surface border border-border rounded-lg px-3 py-2 text-sm placeholder-muted focus:outline-none focus:border-seed/50"
          />
          <select
            value={filterCat}
            onChange={e => setFilterCat(e.target.value)}
            className="bg-surface border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-seed/50"
          >
            <option value="all">All</option>
            <option value="seed">Seed</option>
            <option value="gear">Gear</option>
            <option value="crate">Crates</option>
          </select>
        </div>

        {/* Sell Multipliers */}
        {data?.sell?.entries && (
          <details className="bg-surface border border-border rounded-xl">
            <summary className="px-4 py-3 cursor-pointer text-sm font-semibold hover:bg-white/[0.02] rounded-xl">
              Sell Price Multipliers ({data.sell.entries.length} items)
            </summary>
            <div className="px-4 pb-3 max-h-60 overflow-y-auto">
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5 text-xs">
                {data.sell.entries.map(e => (
                  <div key={e.key} className="flex justify-between bg-white/[0.02] px-2 py-1 rounded">
                    <span>{e.name}</span>
                    <span className={e.multiplier >= 1 ? 'text-seed' : 'text-red-400'}>
                      ×{e.multiplier.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </details>
        )}

        {/* Stock Cards */}
        {filteredStock.length === 0 && data?.stock && (
          <div className="text-center text-muted py-12 text-sm">No items match your search.</div>
        )}
        <div className="space-y-4">
          {filteredStock.map(cat => {
            const c = CATEGORIES[cat.category] || { label: cat.category, color: '#6b7280', icon: '📦' }
            const nextRestock = cat.nextRestockAt || cat.items[0]?.nextRestockAt
            return (
              <div key={cat.category} className="bg-surface border border-border rounded-xl overflow-hidden fade-in">
                <div className="flex items-center justify-between px-4 py-3 border-b border-border" style={{ borderLeftColor: c.color, borderLeftWidth: 3 }}>
                  <h2 className="font-bold text-sm flex items-center gap-2">
                    <span style={{ color: c.color }}>{c.icon}</span>
                    {c.label}
                  </h2>
                  <div className="text-xs text-muted text-right">
                    <div className="font-medium" style={{ color: c.color }}>
                      Restock <Countdown target={nextRestock} />
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-1.5 p-3">
                  {cat.items.map(item => (
                    <div key={item.key} className="flex items-center gap-2.5 bg-white/[0.03] rounded-lg px-3 py-2 hover:bg-white/[0.06] transition">
                      <span className="text-xl w-8 text-center flex-shrink-0">{item.emoji || '❓'}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold truncate">{item.name}</div>
                        {item.rarity && (
                          <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: RARITY_COLORS[item.rarity.toLowerCase()] || '#666' }}>
                            {item.rarity}
                          </div>
                        )}
                      </div>
                      <div className={`text-sm font-extrabold flex-shrink-0 px-2 py-0.5 rounded ${
                        item.quantity > 0 ? 'bg-seed/15 text-seed' : 'bg-red-500/10 text-red-400'
                      }`}>
                        ×{item.quantity}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>

        {/* History Chart placeholder */}
        {history.length > 0 && (
          <div className="bg-surface border border-border rounded-xl p-4">
            <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-3">Recent Stock Changes</h3>
            <div className="max-h-48 overflow-y-auto space-y-1 text-xs">
              {history.slice(0, 30).map((row, i) => (
                <div key={i} className="flex justify-between bg-white/[0.02] px-3 py-1.5 rounded">
                  <span className="text-muted">{row.timestamp?.slice(0, 19).replace('T', ' ')}</span>
                  <span style={{ color: RARITY_COLORS[row.rarity?.toLowerCase()] }}>{row.item_name}</span>
                  <span className={row.quantity > 0 ? 'text-seed' : 'text-red-400'}>{row.category} ×{row.quantity}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      <footer className="text-center py-4 text-xs text-muted border-t border-border">
        Data from <a href="https://gag2.gg" className="text-gear hover:underline" target="_blank">gag2.gg</a>
        {' | '}Backend: <a href={`${API}/docs`} className="text-gear hover:underline" target="_blank">API Docs</a>
      </footer>

      {/* Hidden notification sound */}
      <audio ref={notifyRef} src="data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACAf39/f4B/f3+AgH+AgH9/f3+AgH9/f39/gICAf39/f39/gICAf39/gH9/f3+AgH9/f39/gICAf39/f3+AgH+AgH9/f39/gICAf39/gH9/f39/gICAf39/f3+AgH+AgH9/f39/gICAf39/f39/gICAf39/gH9/f3+AgH9/f39/gICAf39/f3+AgH+AgH9/f3+AgH9/f39/gICAf39/gH9/f39/gICAf39/f3+AgH9/f3+AgH9/f3+AgH9/f3+AgH9/f39/gICAf39/f3+AgH+AgH+AgH9/f3+AgH9/f39/gICAf39/f3+AgH+AgH+AgH+AgH+AgH+AgH9/f3+AgH9/f39/gICAf39/f3+AgH9/gICAf39/f4B/f39/gICAf39/f3+AgH9/gICAf39/gH+AgH9/f3+AgH+AgH9/f3+AgH+AgH9/f3+AgH+AgH+AgH+AgH+AgH+AgH+AgH9/f3+AgH+AgH+AgH+AgH+AgH+AgH+AgH+AgH+AgH+AgH+AgH+AgH9/f3+AgH+AgH+AgH+AgH9/f39/gICAf39/f3+AgH9/f39/gICAf39/f3+AgH9/f39/gICAf39/f4B/f39/gICAf39/f4B/f3+Af39/gH+Af39/gH+Af39/gH+Af39/gH+Af39/gH+Af39/f39/gH+Af39/f39/gICAf39/f3+AgH+AgH9/f39/gH+Af39/gH+Af39/gH+Af39/gH+Af39/gH+Af39/f39/gH+Af39/f39/gICAf39/f3+Af39/f39/gICAf39/f39/gICAf39/gH+AgH9/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/gH+Af39/f4B/f3+Af39/gH+Af39/f39/gICAf39/f3+AgH+Af39/gH+Af39/f39/gICAf39/f3+Af39/f4B/f39/gICAf39/f39/gICAf39/gH9/f3+Af39/gH9/f3+Af39/f4B/f39/gICAf39/gH9/f3+Af39/f4B/f3+Af39/gH+Af39/gH9/f3+Af39/gH9/f3+Af39/f4B/f39/gH+Af39/gH9/f3+Af39/gH9/f39/gH+Af39/f39/gH+Af39/gH9/f3+Af39/gH9/f3+Af39/gH9/f3+AgH9/f39/gICAf39/f3+AgH9/f39/gICAf39/f3+AgH9/f39/gICAf39/f39/gICAf39/f3+AgH9/f3+AgH9/f3+AgH9/f3+AgH9/f39/gICAf39/f3+AgH9/f39/gICAf39/gICAf39/f3+AgH9/f39/gH+Af39/f39/gICAf39/f39/gICAf39/f39/gH+Af39/gH9/f3+Af39/gH9/f39/gICAf39/f39/gICAf39/f39/gICAf39/f3+AgH9/f3+AgH9/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/gH9/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gH+Af39/gH+Af39/gH9/f3+AgH9/gICAf39/f39/gICAf39/gH9/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gICAf39/f39/gH+Af39/f39/gH+Af39/AAA=" />
    </div>
  )
}
