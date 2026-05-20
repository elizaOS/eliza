"""
Checkpoint Sync — Automated upload/download of training checkpoints.

Supports two backends:
  1. S3-compatible storage (MinIO, AWS S3, Nebius Object Storage)
  2. rsync over SSH

Environment variables:
    CHECKPOINT_SYNC_BACKEND   "s3" or "rsync" (default: "s3")

    # S3 backend:
    CHECKPOINT_S3_BUCKET      Bucket name (default: "babylon-checkpoints")
    CHECKPOINT_S3_PREFIX      Key prefix (default: "training/")
    CHECKPOINT_S3_ENDPOINT    S3 endpoint URL (for MinIO/Nebius)
    AWS_ACCESS_KEY_ID         S3 credentials
    AWS_SECRET_ACCESS_KEY     S3 credentials

    # rsync backend:
    CHECKPOINT_RSYNC_HOST     Remote host (e.g., "shaw@89.169.123.213")
    CHECKPOINT_RSYNC_PATH     Remote directory (default: "~/babylon-checkpoints/")
    CHECKPOINT_RSYNC_KEY      SSH key path (optional)
"""

from __future__ import annotations

import logging
import os
import re
import subprocess
from abc import ABC, abstractmethod
from pathlib import Path

logger = logging.getLogger(__name__)

# Subprocess timeout for all SSH/rsync operations (5 minutes)
_SUBPROCESS_TIMEOUT = 300

# Tags must be safe filesystem/S3 names: alphanumeric, dash, underscore, dot
_SAFE_TAG_RE = re.compile(r"^[a-zA-Z0-9._-]+$")


def _validate_tag(tag: str) -> None:
    """Reject tags with shell-injection risk or unsafe chars."""
    if not tag or not _SAFE_TAG_RE.match(tag):
        raise ValueError(
            f"Invalid checkpoint tag: {tag!r}. "
            f"Tags must match [a-zA-Z0-9._-]+"
        )


def _ssh_base_cmd(ssh_key: str | None) -> list[str]:
    """Build base SSH command with optional key."""
    cmd = ["ssh", "-o", "StrictHostKeyChecking=no"]
    if ssh_key:
        cmd.extend(["-i", ssh_key])
    return cmd


class CheckpointSyncBackend(ABC):
    """Abstract backend for checkpoint upload/download."""

    @abstractmethod
    def upload(self, local_path: str, tag: str) -> str:
        """Upload checkpoint directory. Returns remote identifier."""

    @abstractmethod
    def download(self, tag: str, local_path: str) -> bool:
        """Download checkpoint to local path. Returns success."""

    @abstractmethod
    def list_remote(self) -> list[dict[str, str]]:
        """List available remote checkpoints, sorted oldest→newest by tag."""

    @abstractmethod
    def delete_remote(self, tag: str) -> bool:
        """Delete a remote checkpoint."""


class S3SyncBackend(CheckpointSyncBackend):
    """S3-compatible checkpoint sync using boto3."""

    def __init__(
        self,
        bucket: str = "babylon-checkpoints",
        prefix: str = "training/",
        endpoint_url: str | None = None,
    ):
        self.bucket = bucket
        self.prefix = prefix.rstrip("/") + "/"
        self.endpoint_url = endpoint_url
        self._client = None

    @property
    def client(self):
        if self._client is None:
            try:
                import boto3
            except ImportError:
                raise ImportError(
                    "boto3 is required for S3 checkpoint sync. "
                    "Install it with: pip install boto3"
                )
            kwargs = {}
            if self.endpoint_url:
                kwargs["endpoint_url"] = self.endpoint_url
            self._client = boto3.client("s3", **kwargs)
        return self._client

    def upload(self, local_path: str, tag: str) -> str:
        _validate_tag(tag)
        local = Path(local_path)
        if not local.exists():
            raise FileNotFoundError(f"Checkpoint not found: {local_path}")

        remote_prefix = f"{self.prefix}{tag}/"
        uploaded = 0

        for file_path in local.rglob("*"):
            if file_path.is_file():
                key = f"{remote_prefix}{file_path.relative_to(local)}"
                logger.info(f"Uploading {file_path} → s3://{self.bucket}/{key}")
                self.client.upload_file(str(file_path), self.bucket, key)
                uploaded += 1

        logger.info(f"Uploaded {uploaded} files to s3://{self.bucket}/{remote_prefix}")
        return f"s3://{self.bucket}/{remote_prefix}"

    def download(self, tag: str, local_path: str) -> bool:
        _validate_tag(tag)
        remote_prefix = f"{self.prefix}{tag}/"
        local = Path(local_path)
        local.mkdir(parents=True, exist_ok=True)

        paginator = self.client.get_paginator("list_objects_v2")
        downloaded = 0

        for page in paginator.paginate(Bucket=self.bucket, Prefix=remote_prefix):
            for obj in page.get("Contents", []):
                key = obj["Key"]
                rel_path = key[len(remote_prefix):]
                if not rel_path:
                    continue
                dest = local / rel_path
                dest.parent.mkdir(parents=True, exist_ok=True)
                # Download to temp file, then atomic rename
                tmp = dest.with_suffix(dest.suffix + ".tmp")
                self.client.download_file(self.bucket, key, str(tmp))
                tmp.rename(dest)
                downloaded += 1

        logger.info(f"Downloaded {downloaded} files to {local_path}")
        return downloaded > 0

    def list_remote(self) -> list[dict[str, str]]:
        paginator = self.client.get_paginator("list_objects_v2")
        tags: set[str] = set()

        for page in paginator.paginate(
            Bucket=self.bucket, Prefix=self.prefix, Delimiter="/"
        ):
            for prefix in page.get("CommonPrefixes", []):
                tag = prefix["Prefix"][len(self.prefix):].rstrip("/")
                if tag:
                    tags.add(tag)

        return [
            {"tag": t, "location": f"s3://{self.bucket}/{self.prefix}{t}/"}
            for t in _sort_tags_by_step(tags)
        ]

    def delete_remote(self, tag: str) -> bool:
        _validate_tag(tag)
        remote_prefix = f"{self.prefix}{tag}/"
        paginator = self.client.get_paginator("list_objects_v2")
        objects = []

        for page in paginator.paginate(Bucket=self.bucket, Prefix=remote_prefix):
            for obj in page.get("Contents", []):
                objects.append({"Key": obj["Key"]})

        if objects:
            # S3 DeleteObjects handles max 1000 per call
            for i in range(0, len(objects), 1000):
                batch = objects[i : i + 1000]
                self.client.delete_objects(
                    Bucket=self.bucket, Delete={"Objects": batch}
                )
            logger.info(f"Deleted {len(objects)} objects for tag {tag}")
            return True
        return False


class RsyncSyncBackend(CheckpointSyncBackend):
    """rsync over SSH checkpoint sync."""

    def __init__(
        self,
        host: str,
        remote_path: str = "~/babylon-checkpoints/",
        ssh_key: str | None = None,
    ):
        self.host = host
        self.remote_path = remote_path.rstrip("/") + "/"
        self.ssh_key = ssh_key

    def _rsync_cmd(self, src: str, dst: str) -> list[str]:
        cmd = ["rsync", "-avz", "--progress"]
        ssh_parts = ["ssh", "-o", "StrictHostKeyChecking=no"]
        if self.ssh_key:
            ssh_parts.extend(["-i", self.ssh_key])
        cmd.extend(["-e", " ".join(ssh_parts)])
        cmd.extend([src, dst])
        return cmd

    def _ssh_run(self, remote_cmd: list[str], timeout: int = _SUBPROCESS_TIMEOUT) -> subprocess.CompletedProcess:
        """Run a command on remote host via SSH. Args are passed as list, not shell string."""
        cmd = _ssh_base_cmd(self.ssh_key)
        cmd.append(self.host)
        cmd.extend(remote_cmd)
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)

    def upload(self, local_path: str, tag: str) -> str:
        _validate_tag(tag)
        local = Path(local_path)
        if not local.exists():
            raise FileNotFoundError(f"Checkpoint not found: {local_path}")

        remote_dest = f"{self.host}:{self.remote_path}{tag}/"
        # Ensure remote directory exists — use list args, not shell string
        self._ssh_run(["mkdir", "-p", f"{self.remote_path}{tag}"])

        cmd = self._rsync_cmd(f"{local_path}/", remote_dest)
        logger.info(f"rsync upload: {local_path} → {remote_dest}")
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=_SUBPROCESS_TIMEOUT
        )
        if result.returncode != 0:
            logger.error(f"rsync failed: {result.stderr}")
            raise RuntimeError(f"rsync upload failed: {result.stderr}")

        logger.info(f"Uploaded checkpoint to {remote_dest}")
        return remote_dest

    def download(self, tag: str, local_path: str) -> bool:
        _validate_tag(tag)
        local = Path(local_path)
        local.mkdir(parents=True, exist_ok=True)

        remote_src = f"{self.host}:{self.remote_path}{tag}/"
        cmd = self._rsync_cmd(remote_src, f"{local_path}/")
        logger.info(f"rsync download: {remote_src} → {local_path}")
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=_SUBPROCESS_TIMEOUT
        )
        if result.returncode != 0:
            logger.error(f"rsync download failed: {result.stderr}")
            return False

        logger.info(f"Downloaded checkpoint to {local_path}")
        return True

    def list_remote(self) -> list[dict[str, str]]:
        try:
            result = self._ssh_run(
                ["ls", "-1", self.remote_path], timeout=30
            )
        except subprocess.TimeoutExpired:
            logger.error("SSH ls timed out")
            return []

        if result.returncode != 0:
            # Could be missing dir or SSH failure — log for visibility
            if result.stderr.strip():
                logger.warning(f"SSH ls failed: {result.stderr.strip()}")
            return []

        tags = [
            line.strip() for line in result.stdout.strip().split("\n")
            if line.strip() and _SAFE_TAG_RE.match(line.strip())
        ]
        return [
            {"tag": t, "location": f"{self.host}:{self.remote_path}{t}/"}
            for t in _sort_tags_by_step(tags)
        ]

    def delete_remote(self, tag: str) -> bool:
        _validate_tag(tag)
        try:
            result = self._ssh_run(
                ["rm", "-rf", f"{self.remote_path}{tag}"], timeout=60
            )
            return result.returncode == 0
        except subprocess.TimeoutExpired:
            logger.error(f"SSH rm timed out for tag {tag}")
            return False


def _sort_tags_by_step(tags: set[str] | list[str]) -> list[str]:
    """Sort checkpoint tags by numeric step suffix (crl_step_5 < crl_step_10).

    Falls back to lexicographic sort for tags without numeric suffixes.
    """
    def _extract_step(tag: str) -> tuple[int, str]:
        # Try to extract trailing number: crl_step_5 → 5
        m = re.search(r"(\d+)$", tag)
        if m:
            return (int(m.group(1)), tag)
        return (0, tag)

    return sorted(tags, key=_extract_step)


class CheckpointSyncer:
    """
    High-level checkpoint sync manager.

    Handles upload after save, download before resume, and cleanup of old checkpoints.
    """

    def __init__(self, backend: CheckpointSyncBackend, keep_last: int = 5):
        self.backend = backend
        self.keep_last = keep_last

    @classmethod
    def from_env(cls) -> "CheckpointSyncer":
        """Create syncer from environment variables."""
        backend_type = os.environ.get("CHECKPOINT_SYNC_BACKEND", "s3")

        if backend_type == "rsync":
            host = os.environ.get("CHECKPOINT_RSYNC_HOST")
            if not host:
                raise ValueError("CHECKPOINT_RSYNC_HOST is required for rsync backend")
            backend: CheckpointSyncBackend = RsyncSyncBackend(
                host=host,
                remote_path=os.environ.get("CHECKPOINT_RSYNC_PATH", "~/babylon-checkpoints/"),
                ssh_key=os.environ.get("CHECKPOINT_RSYNC_KEY"),
            )
        elif backend_type == "s3":
            backend = S3SyncBackend(
                bucket=os.environ.get("CHECKPOINT_S3_BUCKET", "babylon-checkpoints"),
                prefix=os.environ.get("CHECKPOINT_S3_PREFIX", "training/"),
                endpoint_url=os.environ.get("CHECKPOINT_S3_ENDPOINT"),
            )
        else:
            raise ValueError(
                f"Unknown CHECKPOINT_SYNC_BACKEND: {backend_type!r}. "
                f"Supported: 's3', 'rsync'"
            )

        keep_last = int(os.environ.get("CHECKPOINT_KEEP_LAST", "5"))
        return cls(backend, keep_last=keep_last)

    def upload(self, local_path: str, tag: str | None = None) -> str:
        """Upload checkpoint, auto-prune old ones."""
        if tag is None:
            tag = Path(local_path).name
        location = self.backend.upload(local_path, tag)
        self._prune_old()
        return location

    def download(self, tag: str, local_path: str) -> bool:
        return self.backend.download(tag, local_path)

    def download_latest(self, local_path: str) -> bool:
        """Download the most recent checkpoint."""
        remotes = self.backend.list_remote()
        if not remotes:
            logger.info("No remote checkpoints available")
            return False
        latest = remotes[-1]
        logger.info(f"Downloading latest checkpoint: {latest['tag']}")
        return self.backend.download(latest["tag"], local_path)

    def list_remote(self) -> list[dict[str, str]]:
        return self.backend.list_remote()

    def _prune_old(self) -> None:
        """Delete old checkpoints beyond keep_last (sorted by step number)."""
        if self.keep_last <= 0:
            return
        remotes = self.backend.list_remote()  # already sorted oldest→newest
        if len(remotes) <= self.keep_last:
            return
        to_delete = remotes[: len(remotes) - self.keep_last]
        for entry in to_delete:
            logger.info(f"Pruning old checkpoint: {entry['tag']}")
            self.backend.delete_remote(entry["tag"])
