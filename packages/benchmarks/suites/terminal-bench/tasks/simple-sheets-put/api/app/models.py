from datetime import datetime, timezone
from typing import Dict

from sqlalchemy import JSON, Column, DateTime, ForeignKey, Integer, String
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import relationship

Base = declarative_base()


class Spreadsheet(Base):
    __tablename__ = "spreadsheets"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, index=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
    sheets = relationship(
        "Sheet", back_populates="spreadsheet", cascade="all, delete-orphan"
    )


class Sheet(Base):
    __tablename__ = "sheets"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, index=True)
    spreadsheet_id = Column(Integer, ForeignKey("spreadsheets.id"))
    data: Column[Dict[str, Dict]] = Column(JSON, default=dict)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    spreadsheet = relationship("Spreadsheet", back_populates="sheets")
