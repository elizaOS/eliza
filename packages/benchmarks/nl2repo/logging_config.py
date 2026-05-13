#!/usr/bin/env python3
"""
日志配置模块
提供标准化的日志格式和配置，支持控制台和文件输出
"""

import logging
import logging.handlers
import os
import threading
from datetime import datetime
from typing import Optional


class ColoredFormatter(logging.Formatter):
    """带颜色的格式化器，用于控制台输出"""
    
    # ANSI颜色代码
    COLORS = {
        'DEBUG': '\033[36m',      #  cyan
        'INFO': '\033[32m',       #  green
        'WARNING': '\033[33m',    # yellow
        'ERROR': '\033[31m',      # red
        'CRITICAL': '\033[35m',   # magenta
        'RESET': '\033[0m',       # Reset 
        'PID': '\033[35m',        # magenta for PID
        'THREAD': '\033[90m',     # dark gray for thread
        'LOGGER': '\033[36m'      # cyan for logger name
    }
    
    def format(self, record):
        # Get process ID
        pid = os.getpid()
        
        # Get trace ID (if exists)
        trace_id = getattr(record, 'traceId', '')
        trace_id_str = f"[{trace_id}]" if trace_id else "[-]"
        
        # Format timestamp
        dt = datetime.fromtimestamp(record.created)
        timestamp = dt.strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]  # 毫秒精度
        
        # Format log level (5 chars width, right aligned)
        level_color = self.COLORS.get(record.levelname, '')
        level_str = f"{level_color}{record.levelname:>5}{self.COLORS['RESET']}"
        
        # Format PID
        pid_str = f"{self.COLORS['PID']}{pid}{self.COLORS['RESET']}"
        
        # Format thread name
        thread_name = threading.current_thread().name
        thread_str = f"[{thread_name}]"
        
        # Format logger name (max 40 chars)
        logger_name = record.name[-40:] if len(record.name) > 40 else record.name
        logger_str = f"{self.COLORS['LOGGER']}{logger_name:<40}{self.COLORS['RESET']}"
        
        # Format separator
        separator = f"{self.COLORS['THREAD']}---{self.COLORS['RESET']}"
        
        # Assemble final format
        formatted = f"{timestamp} {level_str} {pid_str} {separator} {thread_str} {trace_id_str} {logger_str} : {record.getMessage()}"
        
        # Add exception info
        if record.exc_info:
            formatted += '\n' + self.formatException(record.exc_info)
            
        return formatted


class PlainFormatter(logging.Formatter):
    """Plain text formatter for file output"""
    
    def format(self, record):
        # Get process ID
        pid = os.getpid()
        
        # Get trace ID (if exists)
        trace_id = getattr(record, 'traceId', '')
        trace_id_str = f"[{trace_id}]" if trace_id else "[-]"
        
        # Format timestamp
        dt = datetime.fromtimestamp(record.created)
        timestamp = dt.strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]  # 毫秒精度
        
        # Format log level (5 chars width, right aligned)
        level_str = f"{record.levelname:>5}"
        
        # Format thread name
        thread_name = threading.current_thread().name
        thread_str = f"[{thread_name}]"
        
        # Format logger name (max 40 chars)
        logger_name = record.name[-40:] if len(record.name) > 40 else record.name
        logger_str = f"{logger_name:<40}"
        
        # Assemble final format
        formatted = f"{timestamp} {level_str} {pid} --- {thread_str} {trace_id_str} {logger_str} : {record.getMessage()}"
        
        # Add exception info
        if record.exc_info:
            formatted += '\n' + self.formatException(record.exc_info)
            
        return formatted


def setup_logging(
    level: str = "INFO",
    log_file: Optional[str] = None,
    max_file_size: int = 10 * 1024 * 1024,  # 10MB
    backup_count: int = 5
) -> None:
    """
    Set up logging configuration
    
    Args:
        level: Log level (DEBUG, INFO, WARNING, ERROR, CRITICAL)
        log_file: Log file path, None to disable file logging
        max_file_size: Maximum log file size (bytes)
        backup_count: Number of backup files to keep
    """
    # Get root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(getattr(logging, level.upper()))
    
    # Clear existing handlers
    root_logger.handlers.clear()
    
    # Set up console handler
    console_handler = logging.StreamHandler()
    console_handler.setFormatter(ColoredFormatter())
    root_logger.addHandler(console_handler)
    
    # Set up file handler (if log_file is specified)
    if log_file:
        # Ensure log directory exists
        os.makedirs(os.path.dirname(log_file), exist_ok=True)
        
        # Use RotatingFileHandler for log rotation
        file_handler = logging.handlers.RotatingFileHandler(
            log_file,
            maxBytes=max_file_size,
            backupCount=backup_count,
            encoding='utf-8'
        )
        file_handler.setFormatter(PlainFormatter())
        root_logger.addHandler(file_handler)


def get_logger(name: str) -> logging.Logger:
    """
    Get logger with specified name
    
    Args:
        name: Logger name
        
    Returns:
        Logger instance
    """
    return logging.getLogger(name)




if __name__ != "__main__":
    setup_logging(level="INFO", log_file="logs/application.log")