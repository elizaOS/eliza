import shutil
from pathlib import Path


NOSYMFOLLOW_MOUNTPOINT = Path("/run/nosymfollow")
MIGRATIONS_DIR = (
    NOSYMFOLLOW_MOUNTPOINT / "live/persistence/TailsData_unlocked/.tails/migrations"
)


class Migration:
    def __init__(self, Id: str):
        self.state_dir = MIGRATIONS_DIR / Id
        self.success_file = self.state_dir / "success"
        self.failure_file = self.state_dir / "failure"
        self.not_needed_file = self.state_dir / "not_needed"

    def create_state_directory(self) -> None:
        self.state_dir.mkdir(mode=0o750, exist_ok=True)
        shutil.chown(self.state_dir, group="amnesia")

    @property
    def succeeded(self):
        return self.success_file.exists()

    @succeeded.setter
    def succeeded(self, result: bool) -> None:
        self.create_state_directory()
        if result:
            self.success_file.touch()
            self.failure_file.unlink(missing_ok=True)
        else:
            self.success_file.unlink(missing_ok=True)
            self.failure_file.touch()

    @property
    def not_needed(self):
        return self.not_needed_file.exists()

    @not_needed.setter
    def not_needed(self, value: bool) -> None:
        self.create_state_directory()
        if value:
            self.not_needed_file.touch()
        else:
            self.not_needed_file.unlink(missing_ok=True)


if __name__ == "__main__":
    import sys

    migration = Migration(sys.argv[1])
    if migration.succeeded:
        sys.exit(0)
    else:
        sys.exit(1)
