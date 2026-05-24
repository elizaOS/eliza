"""Pure-numpy binary STL read/write and mesh deformation utilities."""
import numpy as np
import struct
from pathlib import Path


def read_stl(path: str) -> tuple[np.ndarray, np.ndarray]:
    """Read binary STL. Returns (normals Nx3, vertices Nx3x3)."""
    with open(path, "rb") as f:
        f.read(80)  # header
        n_tris = struct.unpack("<I", f.read(4))[0]
        raw = np.frombuffer(f.read(n_tris * 50), dtype=np.uint8).reshape(n_tris, 50)
    normals = raw[:, :12].view(np.float32).reshape(n_tris, 3)
    vertices = raw[:, 12:48].view(np.float32).reshape(n_tris, 3, 3)
    return normals, vertices


def write_stl(path: str, normals: np.ndarray, vertices: np.ndarray) -> None:
    """Write binary STL from normals Nx3 and vertices Nx3x3."""
    n_tris = len(normals)
    with open(path, "wb") as f:
        f.write(b"Modified by asimov-feminine" + b" " * (80 - 27))
        f.write(struct.pack("<I", n_tris))
        for i in range(n_tris):
            f.write(normals[i].astype(np.float32).tobytes())
            f.write(vertices[i].astype(np.float32).tobytes())
            f.write(b"\x00\x00")  # attribute


def bbox(vertices: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return (min_xyz, max_xyz) bounding box of Nx3x3 vertex array."""
    verts = vertices.reshape(-1, 3)
    return verts.min(axis=0), verts.max(axis=0)


def centroid(vertices: np.ndarray) -> np.ndarray:
    return vertices.reshape(-1, 3).mean(axis=0)


def recalc_normals(vertices: np.ndarray) -> np.ndarray:
    """Recompute face normals from vertices Nx3x3."""
    e1 = vertices[:, 1] - vertices[:, 0]
    e2 = vertices[:, 2] - vertices[:, 0]
    n = np.cross(e1, e2)
    norms = np.linalg.norm(n, axis=1, keepdims=True)
    norms = np.where(norms < 1e-12, 1.0, norms)
    return n / norms


def scale_mesh(vertices: np.ndarray, sx: float, sy: float, sz: float,
               origin: np.ndarray | None = None) -> np.ndarray:
    """Scale vertices non-uniformly about origin (default centroid)."""
    verts = vertices.reshape(-1, 3).copy()
    if origin is None:
        origin = verts.mean(axis=0)
    verts -= origin
    verts *= np.array([sx, sy, sz])
    verts += origin
    return verts.reshape(vertices.shape)


def scale_axis_range(vertices: np.ndarray, axis: int, scale: float,
                     lo_frac: float = 0.0, hi_frac: float = 1.0,
                     origin: np.ndarray | None = None) -> np.ndarray:
    """Scale only the portion of verts within [lo_frac, hi_frac] of the bbox along axis."""
    verts = vertices.reshape(-1, 3).copy()
    mn = verts[:, axis].min()
    mx = verts[:, axis].max()
    span = mx - mn
    lo = mn + span * lo_frac
    hi = mn + span * hi_frac
    mask = (verts[:, axis] >= lo) & (verts[:, axis] <= hi)
    if origin is None:
        sub = verts[mask]
        origin = np.array([sub[:, 0].mean(), sub[:, 1].mean(), sub[:, 2].mean()])
    # Scale all axes *except* the banding axis
    axes = [i for i in range(3) if i != axis]
    for a in axes:
        verts[mask, a] = origin[a] + (verts[mask, a] - origin[a]) * scale
    return verts.reshape(vertices.shape)


def add_bulge(vertices: np.ndarray, axis_fwd: int, axis_up: int,
              up_frac_lo: float, up_frac_hi: float,
              bulge_max: float, falloff: float = 2.0) -> np.ndarray:
    """Add a smooth outward bulge to vertices in a height band.

    axis_fwd: axis to push outward (e.g. 1 for Y-forward)
    axis_up: vertical axis (e.g. 2 for Z-up)
    up_frac_lo/hi: fraction of bounding box height to apply bulge
    bulge_max: max displacement in metres
    falloff: exponent for smooth falloff at edges of band
    """
    verts = vertices.reshape(-1, 3).copy()
    mn_up = verts[:, axis_up].min()
    mx_up = verts[:, axis_up].max()
    span = mx_up - mn_up
    lo = mn_up + span * up_frac_lo
    hi = mn_up + span * up_frac_hi
    mid = (lo + hi) / 2.0
    half = (hi - lo) / 2.0

    mask = (verts[:, axis_up] >= lo) & (verts[:, axis_up] <= hi)
    if mask.sum() == 0:
        return verts.reshape(vertices.shape)

    # normalized 0..1 within band, 0 at edges, 1 at center
    t = np.abs(verts[:, axis_up] - mid) / (half + 1e-9)
    t_clipped = np.clip(t, 0.0, 1.0)
    weight = (1.0 - t_clipped ** falloff)
    weight = weight * mask

    # Only push verts that are on the "forward" side of the center
    fwd_mid = verts[:, axis_fwd].mean()
    fwd_mask = verts[:, axis_fwd] > fwd_mid
    disp = bulge_max * weight * fwd_mask

    verts[:, axis_fwd] += disp
    return verts.reshape(vertices.shape)


def add_split_bulge(vertices: np.ndarray, axis_fwd: int, axis_up: int, axis_lat: int,
                    up_frac_lo: float, up_frac_hi: float,
                    lat_offset: float, lat_sigma: float,
                    bulge_max: float, falloff: float = 2.0) -> np.ndarray:
    """Two laterally-offset breast mounds pushed forward in a height band.

    axis_fwd: axis to push (X=0)
    axis_up: vertical axis (Z=2)
    axis_lat: lateral axis (Y=1)
    lat_offset: distance from lateral center to each mound peak (m)
    lat_sigma: Gaussian width of each mound (m)
    bulge_max: max forward displacement at mound peak (m)
    """
    verts = vertices.reshape(-1, 3).copy()

    # Height weight — smooth bell within [up_frac_lo, up_frac_hi]
    mn_up = verts[:, axis_up].min(); mx_up = verts[:, axis_up].max()
    span = mx_up - mn_up
    lo = mn_up + span * up_frac_lo; hi = mn_up + span * up_frac_hi
    mid_up = (lo + hi) / 2.0; half_up = (hi - lo) / 2.0
    h_mask = (verts[:, axis_up] >= lo) & (verts[:, axis_up] <= hi)
    t = np.abs(verts[:, axis_up] - mid_up) / (half_up + 1e-9)
    h_weight = np.clip(1.0 - np.clip(t, 0.0, 1.0) ** falloff, 0.0, 1.0) * h_mask

    # Lateral weight — sum of two Gaussians at ±lat_offset, normalized so max=1
    lat_mid = (verts[:, axis_lat].max() + verts[:, axis_lat].min()) / 2.0
    d = verts[:, axis_lat] - lat_mid
    lat_weight = (np.exp(-0.5 * (d - lat_offset) ** 2 / (lat_sigma ** 2 + 1e-9)) +
                  np.exp(-0.5 * (d + lat_offset) ** 2 / (lat_sigma ** 2 + 1e-9))) / 2.0

    # Only push verts on the forward side
    fwd_mid = verts[:, axis_fwd].mean()
    fwd_mask = (verts[:, axis_fwd] > fwd_mid).astype(float)

    disp = bulge_max * h_weight * lat_weight * fwd_mask
    verts[:, axis_fwd] += disp
    return verts.reshape(vertices.shape)


def thin_cross_section(vertices: np.ndarray, axis_primary: int,
                       scale_x: float = 0.8, scale_y: float = 0.8) -> np.ndarray:
    """Compress the two axes perpendicular to axis_primary (thin the limb cross-section)."""
    axes = [i for i in range(3) if i != axis_primary]
    verts = vertices.reshape(-1, 3).copy()
    for ax, sc in zip(axes, [scale_x, scale_y]):
        mid = (verts[:, ax].max() + verts[:, ax].min()) / 2.0
        verts[:, ax] = mid + (verts[:, ax] - mid) * sc
    return verts.reshape(vertices.shape)


def cinch_waist(vertices: np.ndarray, axis_long: int, waist_frac: float = 0.45,
                cinch_scale: float = 0.75, band_width: float = 0.25) -> np.ndarray:
    """Pinch the waist in a vertical band, leaving top/bottom fuller."""
    verts = vertices.reshape(-1, 3).copy()
    mn = verts[:, axis_long].min()
    mx = verts[:, axis_long].max()
    span = mx - mn
    center = mn + span * waist_frac
    half = span * band_width / 2.0

    axes = [i for i in range(3) if i != axis_long]
    for ax in axes:
        mid = (verts[:, ax].max() + verts[:, ax].min()) / 2.0
        dist = np.abs(verts[:, axis_long] - center)
        t = np.clip(1.0 - dist / half, 0.0, 1.0)  # 1 at waist center, 0 outside band
        scale = 1.0 - (1.0 - cinch_scale) * t
        verts[:, ax] = mid + (verts[:, ax] - mid) * scale

    return verts.reshape(vertices.shape)


def flare_hips(vertices: np.ndarray, axis_lat: int = 0, axis_up: int = 2,
               frac_lo: float = 0.0, frac_hi: float = 0.4,
               flare_scale: float = 1.15) -> np.ndarray:
    """Flare the lateral width in the lower portion of the mesh (hip width)."""
    verts = vertices.reshape(-1, 3).copy()
    mn = verts[:, axis_up].min()
    mx = verts[:, axis_up].max()
    span = mx - mn
    lo = mn + span * frac_lo
    hi = mn + span * frac_hi
    mask = (verts[:, axis_up] >= lo) & (verts[:, axis_up] <= hi)
    mid = (verts[:, axis_lat].max() + verts[:, axis_lat].min()) / 2.0
    verts[mask, axis_lat] = mid + (verts[mask, axis_lat] - mid) * flare_scale
    return verts.reshape(vertices.shape)


def back_arch(vertices: np.ndarray, axis_fwd: int = 0, axis_up: int = 2,
              up_frac_lo: float = 0.0, up_frac_hi: float = 0.35,
              arch_pull: float = 0.020) -> np.ndarray:
    """Create a subtle lordotic back arch.

    Pulls lower-back vertices (axis_fwd- side) slightly toward center in the
    up_frac_lo..up_frac_hi height band, leaving the upper back extended.
    This creates a concave lower-back curve when the mesh is viewed from the side.
    """
    verts = vertices.reshape(-1, 3).copy()
    mn_up = verts[:, axis_up].min()
    mx_up = verts[:, axis_up].max()
    span = mx_up - mn_up
    lo = mn_up + span * up_frac_lo
    hi = mn_up + span * up_frac_hi

    fwd_mid = verts[:, axis_fwd].mean()

    height_mask = (verts[:, axis_up] >= lo) & (verts[:, axis_up] <= hi)
    back_mask = verts[:, axis_fwd] < fwd_mid  # back side = less than center
    mask = height_mask & back_mask

    if mask.sum() == 0:
        return verts.reshape(vertices.shape)

    # Smooth weight: 1 at height center, 0 at edges
    mid_up = (lo + hi) / 2.0
    t = np.abs(verts[:, axis_up] - mid_up) / ((hi - lo) / 2.0 + 1e-9)
    weight = np.clip(1.0 - t ** 2.0, 0.0, 1.0) * mask

    # Pull the back vertices toward fwd_mid (inward = forward toward center)
    disp = arch_pull * weight
    verts[:, axis_fwd] = np.where(mask, verts[:, axis_fwd] + disp, verts[:, axis_fwd])

    return verts.reshape(vertices.shape)
