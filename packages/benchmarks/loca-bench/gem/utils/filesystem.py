"""Filesystem utilities with NFS compatibility."""

import errno
import os
import shutil


def nfs_safe_rmtree(path: str) -> None:
    """Remove directory tree with NFS error handling.
    
    On NFS, deleted files that are still open get renamed to .nfs* files.
    This function handles such cases gracefully by ignoring busy files.
    
    Args:
        path: Path to directory to remove
    
    Example:
        >>> from gem.utils.filesystem import nfs_safe_rmtree
        >>> nfs_safe_rmtree("/path/to/directory")
    """
    def onerror(func, path, exc_info):
        """Error handler for shutil.rmtree that ignores NFS-related errors."""
        exc_type, exc_value, _ = exc_info
        # Ignore "Device or resource busy" (EBUSY) - NFS silly rename
        # Ignore "Directory not empty" (ENOTEMPTY) - caused by .nfs* files
        if isinstance(exc_value, OSError) and exc_value.errno in (errno.EBUSY, errno.ENOTEMPTY):
            # Check if it's a .nfs* file (NFS silly rename)
            basename = os.path.basename(path)
            if basename.startswith('.nfs') or exc_value.errno == errno.ENOTEMPTY:
                return  # Silently ignore
        # Re-raise other errors
        raise exc_value
    
    shutil.rmtree(path, onerror=onerror)
