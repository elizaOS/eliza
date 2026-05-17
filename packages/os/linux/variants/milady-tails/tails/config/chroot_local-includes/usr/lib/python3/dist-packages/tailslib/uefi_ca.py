from dataclasses import dataclass, asdict


@dataclass
class Detection:
    """
    >>> original = Detection(action_needed=True)
    >>> d = asdict(original)
    >>> new = Detection(**d)
    >>> new.action_needed
    True
    """

    action_needed: bool

    def asdict(self):
        return asdict(self)

    @classmethod
    def fromdict(cls, d):
        return cls(**d)
