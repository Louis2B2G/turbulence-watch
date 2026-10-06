"""Build global turbulence forecast fields for Turbulence Watch.

Writes to $TW_OUT (default ./out):
  manifest.json                              grid definition, sources, valid times, file index
  {product}_{YYYYMMDDHH}_{hash}.u8.gz        global 0.5 deg uint8 grids (row 0 = 90N, col 0 = 180W), gzip
  sigwx_{YYYYMMDDHH}_{TURB|CB}_{hash}.json   official WAFS SIGWX areas (GeoJSON, as published)
File names carry a content hash, so every file is immutable and can be cached forever; only manifest.json changes.

Products (EDR scale: value * 0.0025, 0..0.6375 m^2/3 s^-1; cbtop: value * 0.25 kft):
  wafs340, wafs390   official WAFS gridded turbulence (NOAA AWC rendering, decoded)  at FL340 / FL390
  cbtop              official WAFS cumulonimbus top height
  gfs1, gfs2         GTG-style 8-diagnostic consensus, NOAA GFS 0.25,  layers 250-200 hPa / 200-150 hPa
  ifs1, ifs2         same, ECMWF IFS 0.25 (open data)
  aifs1, aifs2       same, ECMWF AIFS (AI model, open data, 6-hourly)
  conv               storm-turbulence proxy from GFS CAPE, precipitation rate and high cloud, 1 deg neighbourhood max

Every diagnostic is quantile-mapped onto the official WAFS EDR distribution for the same valid time and level,
the way NCAR's GTG remaps diagnostics onto the EDR scale, so all members share the ICAO scale.
"""
import gzip, io, json, math, os, sys, time, datetime as dt
import numpy as np, requests
from PIL import Image

UTC = dt.timezone.utc
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.environ.get("TW_OUT", os.path.join(ROOT, "out"))
PREV = os.environ.get("TW_PREV", os.path.join(ROOT, "out_prev"))
CACHE = os.environ.get("TW_CACHE", os.path.join(ROOT, ".cache"))
HOURS = int(os.environ.get("TW_HOURS", "36"))         # forecast window to build (hours from now; WAFS goes to T+36)
for d in (OUT, CACHE):
    os.makedirs(d, exist_ok=True)
S = requests.Session(); S.headers["User-Agent"] = "turbulence-watch (github.com/Louis2B2G/turbulence-watch)"
NLAT, NLON, DLL = 361, 720, 0.5
LAT05 = 90 - DLL * np.arange(NLAT); LON05 = -180 + DLL * np.arange(NLON)
EDR_SCALE, CB_SCALE = 0.0025, 0.25
LEVELS = (300, 250, 200, 150)
AWC = "https://aviationweather.gov/data/products"


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def get(url, headers=None, timeout=120, tries=4, ok404=True):
    for i in range(tries):
        try:
            r = S.get(url, headers=headers or {}, timeout=timeout)
            if r.status_code in (200, 206):
                return r
            if r.status_code == 404 and ok404:
                return None
        except Exception as e:
            log("retry", url[:90], e)
        time.sleep(3 * (i + 1))
    return None


def cached(name, fetch):
    fn = os.path.join(CACHE, name)
    if os.path.exists(fn) and os.path.getsize(fn) > 0:
        return fn
    b = fetch()
    if not b:
        return None
    open(fn, "wb").write(b)
    return fn


# ------------------------------------------------------------------ official WAFS (AWC renderings)
LAT_MAX = 75.940536


def _ramp():
    stops = [(10, (204, 255, 204), 4), (15, (204, 255, 0), 5), (20, (255, 204, 0), 5), (30, (255, 153, 0), 5),
             (40, (255, 102, 0), 10), (50, (255, 0, 0), 5), (60, (204, 0, 0), 5), (70, (153, 0, 0), 5), (80, (102, 0, 0), 5), (100, (77, 0, 0), 0)]
    cols, vals = [list(stops[0][1])], [10]
    for (v0, c0, n), (v1, c1, _) in zip(stops[:-1], stops[1:]):
        for k in range(1, n + 1):
            f = k / n
            cols.append([c0[i] + (c1[i] - c0[i]) * f for i in range(3)]); vals.append(v0 + (v1 - v0) * f)
    return np.array(cols, float), np.array(vals, float) / 100.0


RAMP_C, RAMP_V = _ramp()


def wafs_issue(now):
    t = now.replace(minute=0, second=0, microsecond=0, hour=(now.hour // 6) * 6)
    for k in range(6):
        iss = t - dt.timedelta(hours=6 * k)
        if get(f"{AWC}/wafs/{iss:%Y%m%d}/{iss:%H}/{iss:%Y%m%d}_{iss:%H}_F06_wafs_250_edr_m.png", timeout=30):
            return iss
    return None


def wafs_field(iss, f, param):
    """decode an AWC WAFS PNG to a float array on the 0.5 deg grid (NaN outside +-75.9)."""
    fn = cached(f"wafs_{iss:%Y%m%d%H}_F{f:02d}_{param}.png",
                lambda: (get(f"{AWC}/wafs/{iss:%Y%m%d}/{iss:%H}/{iss:%Y%m%d}_{iss:%H}_F{f:02d}_wafs_{param}_m.png", timeout=60) or type("x", (), {"content": None})).content)
    if not fn:
        return None
    a = np.array(Image.open(fn).convert("RGBA")).astype(float)
    H, W = a.shape[:2]; alpha = a[..., 3] > 0
    if param.endswith("edr"):
        src = np.full((H, W), 0.05)
        rgb = a[..., :3][alpha]
        idx = np.empty(len(rgb), int)
        for s in range(0, len(rgb), 200000):
            d = ((rgb[s:s + 200000, None, :] - RAMP_C[None, :, :]) ** 2).sum(-1); idx[s:s + 200000] = d.argmin(1)
        src[alpha] = RAMP_V[idx]
    else:
        src = np.zeros((H, W)); src[alpha] = 27 + (a[..., 0][alpha] - 51) * (28 / 183)
    m0 = math.log(math.tan(math.pi / 4 + math.radians(LAT_MAX) / 2))
    lat = np.clip(LAT05, -LAT_MAX, LAT_MAX)
    ii = ((m0 - np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))) / (2 * m0) * H).astype(int).clip(0, H - 1)
    jj = ((LON05 + 179.983902) / 359.967804 * W).astype(int).clip(0, W - 1)
    out = src[ii[:, None], jj[None, :]]
    out[np.abs(LAT05) > LAT_MAX, :] = np.nan
    return out


def sigwx(iss_now, vt):
    """official SIGWX TURB/CB GeoJSON valid at vt from the newest issue covering it -> {kind: text}"""
    for k in range(5):
        iss = iss_now - dt.timedelta(hours=6 * k)
        f = int(round((vt - iss).total_seconds() / 3600))
        if f < 6 or f > 36 or f % 3:
            continue
        out = {}
        for kind in ("TURB", "CB"):
            r = get(f"{AWC}/autosigwx/{iss:%Y%m%d}/{iss:%Y%m%d}_{iss:%H}_F{f:02d}_sigwx_hi_{kind}.geojson", timeout=60)
            if r is not None:
                out[kind] = r.text
        if out:
            return out
    return {}


# ------------------------------------------------------------------ model grids
def gfs_run(now):
    t = now.replace(minute=0, second=0, microsecond=0, hour=(now.hour // 6) * 6)
    for k in range(6):
        run = t - dt.timedelta(hours=6 * k)
        if get(f"https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod/gfs.{run:%Y%m%d}/{run:%H}/atmos/gfs.t{run:%H}z.pgrb2.0p25.f030.idx", timeout=30):
            return run
    return None


def ecmwf_run(now, model):
    t = now.replace(minute=0, second=0, microsecond=0, hour=(now.hour // 12) * 12)
    for k in range(4):
        run = t - dt.timedelta(hours=12 * k)
        if get(f"https://data.ecmwf.int/forecasts/{run:%Y%m%d}/{run:%H}z/{model}/0p25/oper/{run:%Y%m%d%H}0000-36h-oper-fc.index", timeout=30):
            return run
    return None


def gfs_file(run, fh):
    q = (f"https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl?dir=%2Fgfs.{run:%Y%m%d}%2F{run:%H}%2Fatmos&file=gfs.t{run:%H}z.pgrb2.0p25.f{fh:03d}"
         + "".join(f"&var_{v}=on" for v in ("UGRD", "VGRD", "TMP", "HGT", "CAPE", "PRATE", "HCDC"))
         + "".join(f"&lev_{l}_mb=on" for l in LEVELS) + "&lev_surface=on&lev_high_cloud_layer=on")
    def fetch():
        r = get(q, timeout=180)
        return r.content if r is not None and r.content[:4] == b"GRIB" else None
    return cached(f"gfs_{run:%Y%m%d%H}_f{fh:03d}.grb2", fetch)


def ecmwf_file(model, run, step):
    base = f"https://data.ecmwf.int/forecasts/{run:%Y%m%d}/{run:%H}z/{model}/0p25/oper/{run:%Y%m%d%H}0000-{step}h-oper-fc"
    def fetch():
        r = get(base + ".index", timeout=60)
        if r is None:
            return None
        parts = []
        for line in r.text.splitlines():
            try:
                j = json.loads(line)
            except Exception:
                continue
            if j.get("param") in ("u", "v", "t", "gh") and j.get("levtype") == "pl" and str(j.get("levelist")) in {str(l) for l in LEVELS}:
                parts.append((int(j["_offset"]), int(j["_length"])))
        if len(parts) < 16:
            return None
        blob = b""
        for off, ln in sorted(parts):
            rr = get(base + ".grib2", headers={"Range": f"bytes={off}-{off + ln - 1}"}, timeout=120)
            if rr is None:
                return None
            blob += rr.content
        return blob
    return cached(f"{model.split('-')[0]}_{run:%Y%m%d%H}_s{step:03d}.grb2", fetch)


def read_grib(fn):
    import eccodes as ec
    out = {}; lat = lon = None
    with open(fn, "rb") as f:
        while True:
            g = ec.codes_grib_new_from_file(f)
            if g is None:
                break
            try:
                sn = ec.codes_get(g, "shortName"); tl = ec.codes_get(g, "typeOfLevel"); lev = int(ec.codes_get(g, "level"))
                Ni, Nj = ec.codes_get(g, "Ni"), ec.codes_get(g, "Nj")
                la1, lo1 = ec.codes_get(g, "latitudeOfFirstGridPointInDegrees"), ec.codes_get(g, "longitudeOfFirstGridPointInDegrees")
                di, dj = ec.codes_get(g, "iDirectionIncrementInDegrees"), ec.codes_get(g, "jDirectionIncrementInDegrees")
                js = ec.codes_get(g, "jScansPositively")
                vals = ec.codes_get_values(g).reshape(Nj, Ni)
                lats = la1 + (np.arange(Nj) * dj if js else -np.arange(Nj) * dj)
                lons = ((lo1 + np.arange(Ni) * di + 180) % 360) - 180
                if js:
                    vals = vals[::-1]; lats = lats[::-1]
                o = np.argsort(lons); lons = lons[o]; vals = vals[:, o]
                key = (sn, lev if tl == "isobaricInhPa" else 0)
                out[key] = vals.astype(np.float64); lat, lon = lats, lons
            finally:
                ec.codes_release(g)
    return out, lat, lon


R_E, G, OMEGA = 6371000.0, 9.81, 7.292e-5


def diagnostics(F, lat, lon):
    dlat = abs(lat[1] - lat[0]); dlon = abs(lon[1] - lon[0])
    coslat = np.maximum(np.cos(np.radians(lat)), 0.05)[:, None]
    ddx = lambda A: np.gradient(A, axis=1) / (R_E * coslat * np.radians(dlon))
    ddy = lambda A: -np.gradient(A, axis=0) / (R_E * np.radians(dlat))
    f = 2 * OMEGA * np.sin(np.radians(lat))[:, None]
    out = {}
    for lo, hi in ((250, 200), (200, 150)):
        u1, v1, t1, z1 = (F[(k, lo)] for k in ("u", "v", "t", "gh"))
        u2, v2, t2, z2 = (F[(k, hi)] for k in ("u", "v", "t", "gh"))
        dz = np.maximum(z2 - z1, 100.0); um, vm = (u1 + u2) / 2, (v1 + v2) / 2
        vws = np.hypot(u2 - u1, v2 - v1) / dz
        th1 = t1 * (1000.0 / lo) ** 0.2857; th2 = t2 * (1000.0 / hi) ** 0.2857; thm = (th1 + th2) / 2
        ri = np.clip(G / thm * (th2 - th1) / dz / np.maximum(vws ** 2, 1e-10), 0.05, 1e4)
        ux, uy, vx, vy = ddx(um), ddy(um), ddx(vm), ddy(vm)
        defo = np.hypot(ux - vy, vx + uy); div = ux + vy; zeta = vx - uy
        thx, thy = ddx(thm), ddy(thm); gth = np.maximum(np.hypot(thx, thy), 1e-9)
        f2d = (-thx * (ux * thx + vx * thy) - thy * (uy * thx + vy * thy)) / gth
        out[(lo, hi)] = [vws, 1.0 / ri, vws * defo, vws * np.maximum(defo - div, 0), defo, np.maximum(f2d, 0),
                         np.sqrt(0.3 * (zeta + f) ** 2 + defo ** 2) * vws ** 2, np.hypot(um, vm) * defo]
    return out


def qmap(src, target_sorted, mask):
    out = np.full(src.shape, np.nan)
    x = src[mask]; ok = np.isfinite(x)
    r = np.empty(ok.sum()); r[np.argsort(x[ok])] = (np.arange(ok.sum()) + 0.5) / ok.sum()
    vals = np.full(x.shape, np.nan); vals[ok] = target_sorted[np.clip((r * target_sorted.size).astype(int), 0, target_sorted.size - 1)]
    out[mask] = vals
    return out


def to05(A):
    """0.25 deg (721 x 1440, lat 90..-90, lon -180..179.75) -> 0.5 deg (361 x 720) by 2x2 max."""
    if A.shape == (NLAT, NLON):
        return A
    A = A[:721, :1440]
    P = np.vstack([A, np.full((1, A.shape[1]), np.nan)]).reshape(NLAT, 2, NLON, 2)
    return np.fmax(np.fmax(P[:, 0, :, 0], P[:, 0, :, 1]), np.fmax(P[:, 1, :, 0], P[:, 1, :, 1]))


def target_dist(W):
    """sorted, lightly de-quantized sample of a WAFS field (|lat| <= 70) for quantile mapping."""
    rng = np.random.default_rng(0)
    s = W[np.abs(LAT05) <= 70].ravel(); s = s[np.isfinite(s)]
    s = np.where(s <= 0.05, rng.uniform(0.02, 0.10, s.size), s + rng.uniform(-0.005, 0.005, s.size))
    return np.sort(s)


def gtg_layers(fn, t340, t390):
    F, lat, lon = read_grib(fn)
    if any((k, l) not in F for k in ("u", "v", "t", "gh") for l in LEVELS):
        return None, None, F, lat, lon
    D = diagnostics(F, lat, lon)
    mask = np.abs(lat)[:, None] * np.ones((1, len(lon))) <= 80
    res = []
    for layer, target in (((250, 200), t340), ((200, 150), t390)):
        mapped = [qmap(np.log(np.maximum(d, 1e-12)), target, mask) for d in D[layer]]
        res.append(to05(qmap(np.nanmean(mapped, axis=0), target, mask)))
    return res[0], res[1], F, lat, lon


def conv_proxy(F, lat, lon):
    from scipy.ndimage import maximum_filter
    cape = F.get(("cape", 0)); pr = F.get(("prate", 0)); hcc = F.get(("hcc", 0))
    if hcc is None:
        hcc = next((v for (k, l), v in F.items() if k in ("hcc", "tcc") and l == 0), None)
    if cape is None or pr is None:
        return None
    prh = pr * 3600.0
    s = np.clip(prh / 3.0, 0, 1) * np.clip(cape / 1200.0, 0, 1)
    e = 0.30 * np.sqrt(s)
    if hcc is not None:
        e = np.maximum(e, np.where((cape >= 800) & (hcc >= 80), 0.10, 0.0))
    e = np.where(cape < 150, 0.03, np.maximum(e, 0.03))
    return to05(maximum_filter(e, size=9, mode="nearest"))


# ------------------------------------------------------------------ main
def enc(A, scale):
    q = np.nan_to_num(np.round(A / scale), nan=0).clip(0, 255).astype(np.uint8)
    return gzip.compress(q.tobytes(), compresslevel=9)


def main():
    now = dt.datetime.now(UTC)
    w_iss = wafs_issue(now)
    if w_iss is None:
        log("no WAFS issue found"); sys.exit(1)
    runs = {"gfs": gfs_run(now), "ifs": ecmwf_run(now, "ifs"), "aifs": ecmwf_run(now, "aifs-single")}
    sources = {"wafs": w_iss.isoformat(), **{k: (v.isoformat() if v else None) for k, v in runs.items()}}
    log("sources", sources)
    prev = None
    try:
        prev = json.load(open(os.path.join(PREV, "manifest.json")))
    except Exception:
        pass
    if prev and prev.get("sources") == sources and os.environ.get("TW_FORCE") != "1":
        log("unchanged; nothing to publish"); open(os.path.join(OUT, ".unchanged"), "w").write("1"); return
    start = max(w_iss + dt.timedelta(hours=6), now.replace(minute=0, second=0, microsecond=0, hour=(now.hour // 3) * 3) - dt.timedelta(hours=3))
    vts = []
    vt = start
    while vt <= min(w_iss + dt.timedelta(hours=36), now + dt.timedelta(hours=HOURS)):
        vts.append(vt); vt += dt.timedelta(hours=3)
    files = {}
    import hashlib
    def put(prod, vt, data):
        name = f"{prod}_{vt:%Y%m%d%H}_{hashlib.sha1(data).hexdigest()[:8]}.u8.gz"
        open(os.path.join(OUT, name), "wb").write(data)
        files.setdefault(prod, {})[vt.isoformat()] = name
    for vt in vts:
        f = int(round((vt - w_iss).total_seconds() / 3600))
        w340, w390, cb = wafs_field(w_iss, f, "250_edr"), wafs_field(w_iss, f, "197_edr"), wafs_field(w_iss, f, "cbtop_hght")
        if w340 is None or w390 is None:
            log("missing WAFS", vt); continue
        put("wafs340", vt, enc(w340, EDR_SCALE)); put("wafs390", vt, enc(w390, EDR_SCALE))
        if cb is not None:
            put("cbtop", vt, enc(cb, CB_SCALE))
        t340, t390 = target_dist(w340), target_dist(w390)
        for model, run in runs.items():
            if run is None:
                continue
            step = int(round((vt - run).total_seconds() / 3600))
            if step < 0 or step > 120 or (model == "aifs" and step % 6):
                continue
            fn = gfs_file(run, step) if model == "gfs" else ecmwf_file("ifs" if model == "ifs" else "aifs-single", run, step)
            if not fn:
                log("no file", model, step); continue
            try:
                l1, l2, F, lat, lon = gtg_layers(fn, t340, t390)
            except Exception as e:
                log("gtg fail", model, step, e); continue
            if l1 is not None:
                put(f"{model}1", vt, enc(l1, EDR_SCALE)); put(f"{model}2", vt, enc(l2, EDR_SCALE))
            if model == "gfs":
                c = conv_proxy(F, lat, lon)
                if c is not None:
                    put("conv", vt, enc(c, EDR_SCALE))
            log("done", model, vt.isoformat(), f"step {step}")
        sw = sigwx(w_iss, vt)
        for kind, text in sw.items():
            name = f"sigwx_{vt:%Y%m%d%H}_{kind}_{hashlib.sha1(text.encode()).hexdigest()[:8]}.json"
            open(os.path.join(OUT, name), "w").write(text); files.setdefault(f"sigwx_{kind}", {})[vt.isoformat()] = name
    manifest = {"updated": now.isoformat(), "sources": sources,
                "grid": {"lat0": 90.0, "lon0": -180.0, "dlat": -DLL, "dlon": DLL, "nlat": NLAT, "nlon": NLON, "dtype": "uint8", "order": "row-major, row 0 = 90N"},
                "scale": {"edr": EDR_SCALE, "cbtop_kft": CB_SCALE},
                "times": sorted({t for p in files.values() for t in p}), "files": files,
                "weights": {"wafs": 0.4, "ifs": 0.25, "gfs": 0.2, "aifs": 0.15}}
    json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"), indent=1)
    log("manifest", len(manifest["times"]), "times,", sum(len(v) for v in files.values()), "files")
    # keep the previous build's files one more round, so a CDN-cached old manifest never points at missing files
    if prev:
        import shutil
        kept = 0
        for prod in prev.get("files", {}).values():
            for name in prod.values():
                src, dst = os.path.join(PREV, name), os.path.join(OUT, name)
                if os.path.exists(src) and not os.path.exists(dst):
                    shutil.copy(src, dst); kept += 1
        log("kept", kept, "files from the previous build")
    # downloaded GRIB older than ~1.5 days is never needed again
    for fn in os.listdir(CACHE):
        f = os.path.join(CACHE, fn)
        if os.path.isfile(f) and time.time() - os.path.getmtime(f) > 36 * 3600:
            os.remove(f)


if __name__ == "__main__":
    main()
