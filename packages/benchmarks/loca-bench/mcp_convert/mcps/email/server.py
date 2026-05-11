#!/usr/bin/env python3
"""
Simplified Email MCP Server

A Model Context Protocol server that provides Email functionality
using local JSON files as the database instead of connecting to external mail servers.

Uses the common MCP framework for simplified development.
"""

import asyncio
import logging
import sys
import os
import argparse
from typing import Any, Dict

# Suppress logging unless verbose mode is enabled
if os.environ.get('LOCA_QUIET', '').lower() in ('1', 'true', 'yes'):
    logging.basicConfig(level=logging.WARNING, force=True)
    logging.getLogger().setLevel(logging.WARNING)
    for _logger_name in ["mcp", "fastmcp", "mcp.server", "mcp.client"]:
        logging.getLogger(_logger_name).setLevel(logging.WARNING)

# Add project root to path
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, project_root)

from common.mcp.server_base import BaseMCPServer
from common.mcp.tools import ToolRegistry
from mcps.email.database_utils import EmailDatabase


class EmailMCPServer(BaseMCPServer):
    """Email MCP server implementation"""

    def __init__(self, email: str = None, password: str = None):
        super().__init__("simplified-email", "1.0.0")

        # Get data directory from environment variable or use default
        data_dir = os.environ.get('EMAIL_DATA_DIR')
        quiet = os.environ.get('LOCA_QUIET', '').lower() in ('1', 'true', 'yes')
        if data_dir:
            if not quiet:
                print(f"Using Email data directory from environment: {data_dir}", file=sys.stderr)
            os.makedirs(data_dir, exist_ok=True)
        else:
            # Use default data directory if not specified
            data_dir = os.path.join(os.path.dirname(__file__), "data")
            if not quiet:
                print(f"Using default Email data directory: {data_dir}", file=sys.stderr)

        self.db = EmailDatabase(data_dir=data_dir)
        self.tool_registry = ToolRegistry()
        self.auto_login_user = None
        
        # Store credentials for delayed login (after MCP handshake)
        self._pending_login_email = email
        self._pending_login_password = password

        self.setup_tools()

    def _auto_login(self, email: str, password: str):
        """Auto-login the user with provided credentials"""
        quiet = os.environ.get('LOCA_QUIET', '').lower() in ('1', 'true', 'yes')
        try:
            # Auto-login
            result = self.db.login(email, password)
            self.auto_login_user = result
            if not quiet:
                print(f"Auto-logged in as: {result['name']} ({result['email']})", file=sys.stderr)
        except Exception as e:
            if not quiet:
                print(f"Warning: Could not auto-login: {e}", file=sys.stderr)

    def setup_tools(self):
        """Setup all Email tools"""

        # Authentication tools
        self.tool_registry.register(
            name="login",
            description="Login as a specific user",
            input_schema={
                "type": "object",
                "properties": {
                    "email": {"type": "string", "description": "User email address"},
                    "password": {"type": "string", "description": "User password"}
                },
                "required": ["email", "password"]
            },
            handler=self.login
        )

        self.tool_registry.register(
            name="logout",
            description="Logout the current user",
            input_schema={"type": "object", "properties": {}, "required": []},
            handler=self.logout
        )

        self.tool_registry.register(
            name="get_current_user",
            description="Get current logged in user information",
            input_schema={"type": "object", "properties": {}, "required": []},
            handler=self.get_current_user
        )

        self.tool_registry.register(
            name="list_users",
            description="List all available users (for demo purposes)",
            input_schema={"type": "object", "properties": {}, "required": []},
            handler=self.list_users
        )

        self.tool_registry.register(
            name="create_user",
            description="Create a new user account with mailbox",
            input_schema={
                "type": "object",
                "properties": {
                    "email": {"type": "string", "description": "User's email address (must be unique)"},
                    "name": {"type": "string", "description": "User's display name"},
                    "password": {"type": "string", "description": "User's password"}
                },
                "required": ["email", "name", "password"]
            },
            handler=self.create_user
        )

        # Connection check
        self.tool_registry.register(
            name="check_connection",
            description="Check email server connection status",
            input_schema={"type": "object", "properties": {}, "required": []},
            handler=self.check_connection
        )

        # Folder management
        self.tool_registry.register(
            name="get_folders",
            description="Get list of available email folders",
            input_schema={"type": "object", "properties": {}, "required": []},
            handler=self.get_folders
        )

        self.tool_registry.register(
            name="create_folder",
            description="Create new email folder",
            input_schema={
                "type": "object",
                "properties": {
                    "folder_name": {"type": "string", "description": "Name of folder to create"}
                },
                "required": ["folder_name"]
            },
            handler=self.create_folder
        )

        self.tool_registry.register(
            name="delete_folder",
            description="Delete email folder",
            input_schema={
                "type": "object",
                "properties": {
                    "folder_name": {"type": "string", "description": "Name of folder to delete"}
                },
                "required": ["folder_name"]
            },
            handler=self.delete_folder
        )

        # Email reading
        self.tool_registry.register(
            name="get_emails",
            description="Get paginated list of emails from specified folder",
            input_schema={
                "type": "object",
                "properties": {
                    "folder": {"type": "string", "description": "Email folder name", "default": "INBOX"},
                    "page": {"type": "integer", "description": "Page number starting from 1", "default": 1},
                    "page_size": {"type": "integer", "description": "Number of emails per page", "default": 20}
                },
                "required": []
            },
            handler=self.get_emails
        )

        self.tool_registry.register(
            name="read_email",
            description="Read full content of a specific email",
            input_schema={
                "type": "object",
                "properties": {
                    "email_id": {"type": "string", "description": "Email ID to read"}
                },
                "required": ["email_id"]
            },
            handler=self.read_email
        )

        self.tool_registry.register(
            name="search_emails",
            description="Search emails with query string (sorted by date descending)",
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query (subject, from, body content)"},
                    "folder": {"type": "string", "description": "Folder to search in", "default": "INBOX"},
                    "page": {"type": "integer", "description": "Page number starting from 1", "default": 1},
                    "page_size": {"type": "integer", "description": "Number of results per page", "default": 20}
                },
                "required": ["query"]
            },
            handler=self.search_emails
        )

        # Email sending
        self.tool_registry.register(
            name="send_email",
            description="Send an email with optional HTML body, CC, BCC, and attachments",
            input_schema={
                "type": "object",
                "properties": {
                    "to": {"type": "string", "description": "Recipient email address(es), comma-separated"},
                    "subject": {"type": "string", "description": "Email subject"},
                    "body": {"type": "string", "description": "Plain text body"},
                    "html_body": {"type": "string", "description": "HTML body content (optional)"},
                    "cc": {"type": "string", "description": "CC recipients, comma-separated (optional)"},
                    "bcc": {"type": "string", "description": "BCC recipients, comma-separated (optional)"},
                    "attachments": {"type": "array", "items": {"type": "string"}, "description": "List of file paths to attach (optional)"}
                },
                "required": ["to", "subject", "body"]
            },
            handler=self.send_email
        )

        self.tool_registry.register(
            name="reply_email",
            description="Reply to an email",
            input_schema={
                "type": "object",
                "properties": {
                    "email_id": {"type": "string", "description": "ID of email to reply to"},
                    "body": {"type": "string", "description": "Reply message body (plain text)"},
                    "html_body": {"type": "string", "description": "Reply message body (HTML, optional)"},
                    "cc": {"type": "string", "description": "Additional CC recipients (optional)"},
                    "bcc": {"type": "string", "description": "BCC recipients (optional)"},
                    "reply_all": {"type": "boolean", "description": "Whether to reply to all recipients", "default": False}
                },
                "required": ["email_id", "body"]
            },
            handler=self.reply_email
        )

        self.tool_registry.register(
            name="forward_email",
            description="Forward an email to other recipients",
            input_schema={
                "type": "object",
                "properties": {
                    "email_id": {"type": "string", "description": "ID of email to forward"},
                    "to": {"type": "string", "description": "Recipients to forward to"},
                    "body": {"type": "string", "description": "Additional message body (optional)"},
                    "html_body": {"type": "string", "description": "Additional HTML message body (optional)"},
                    "cc": {"type": "string", "description": "CC recipients (optional)"},
                    "bcc": {"type": "string", "description": "BCC recipients (optional)"}
                },
                "required": ["email_id", "to"]
            },
            handler=self.forward_email
        )

        # Email management
        self.tool_registry.register(
            name="delete_email",
            description="Delete an email",
            input_schema={
                "type": "object",
                "properties": {
                    "email_id": {"type": "string", "description": "Email ID to delete"}
                },
                "required": ["email_id"]
            },
            handler=self.delete_email
        )

        self.tool_registry.register(
            name="move_email",
            description="Move email to another folder",
            input_schema={
                "type": "object",
                "properties": {
                    "email_id": {"type": "string", "description": "Email ID to move"},
                    "target_folder": {"type": "string", "description": "Target folder name"}
                },
                "required": ["email_id", "target_folder"]
            },
            handler=self.move_email
        )

        self.tool_registry.register(
            name="mark_emails",
            description="Mark multiple emails with status (read/unread/important/not_important)",
            input_schema={
                "type": "object",
                "properties": {
                    "email_ids": {"type": "array", "items": {"type": "string"}, "description": "List of email IDs to mark"},
                    "status": {"type": "string", "description": "Status to set (read, unread, important, not_important)"}
                },
                "required": ["email_ids", "status"]
            },
            handler=self.mark_emails
        )

        self.tool_registry.register(
            name="move_emails",
            description="Move multiple emails to another folder",
            input_schema={
                "type": "object",
                "properties": {
                    "email_ids": {"type": "array", "items": {"type": "string"}, "description": "List of email IDs to move"},
                    "target_folder": {"type": "string", "description": "Target folder name"}
                },
                "required": ["email_ids", "target_folder"]
            },
            handler=self.move_emails
        )

        self.tool_registry.register(
            name="delete_emails",
            description="Delete multiple emails",
            input_schema={
                "type": "object",
                "properties": {
                    "email_ids": {"type": "array", "items": {"type": "string"}, "description": "List of email IDs to delete"}
                },
                "required": ["email_ids"]
            },
            handler=self.delete_emails
        )

        # Draft management
        self.tool_registry.register(
            name="save_draft",
            description="Save email draft",
            input_schema={
                "type": "object",
                "properties": {
                    "subject": {"type": "string", "description": "Email subject"},
                    "body": {"type": "string", "description": "Plain text body"},
                    "html_body": {"type": "string", "description": "HTML body content (optional)"},
                    "to": {"type": "string", "description": "Recipient email address(es) (optional)"},
                    "cc": {"type": "string", "description": "CC recipients (optional)"},
                    "bcc": {"type": "string", "description": "BCC recipients (optional)"}
                },
                "required": ["subject", "body"]
            },
            handler=self.save_draft
        )

        self.tool_registry.register(
            name="get_drafts",
            description="Get list of saved drafts",
            input_schema={
                "type": "object",
                "properties": {
                    "page": {"type": "integer", "description": "Page number starting from 1", "default": 1},
                    "page_size": {"type": "integer", "description": "Number of drafts per page", "default": 20}
                },
                "required": []
            },
            handler=self.get_drafts
        )

        self.tool_registry.register(
            name="update_draft",
            description="Update existing draft",
            input_schema={
                "type": "object",
                "properties": {
                    "draft_id": {"type": "string", "description": "Draft ID to update"},
                    "subject": {"type": "string", "description": "Email subject (optional)"},
                    "body": {"type": "string", "description": "Plain text body (optional)"},
                    "html_body": {"type": "string", "description": "HTML body content (optional)"},
                    "to": {"type": "string", "description": "Recipient email address(es) (optional)"},
                    "cc": {"type": "string", "description": "CC recipients (optional)"},
                    "bcc": {"type": "string", "description": "BCC recipients (optional)"}
                },
                "required": ["draft_id"]
            },
            handler=self.update_draft
        )

        self.tool_registry.register(
            name="delete_draft",
            description="Delete draft",
            input_schema={
                "type": "object",
                "properties": {
                    "draft_id": {"type": "string", "description": "Draft ID to delete"}
                },
                "required": ["draft_id"]
            },
            handler=self.delete_draft
        )

        # Statistics
        self.tool_registry.register(
            name="get_mailbox_stats",
            description="Get mailbox statistics",
            input_schema={
                "type": "object",
                "properties": {
                    "folder_name": {"type": "string", "description": "Specific folder name (optional)"}
                },
                "required": []
            },
            handler=self.get_mailbox_stats
        )

        self.tool_registry.register(
            name="get_unread_count",
            description="Get unread message count",
            input_schema={
                "type": "object",
                "properties": {
                    "folder_name": {"type": "string", "description": "Specific folder name (optional)"}
                },
                "required": []
            },
            handler=self.get_unread_count
        )

        self.tool_registry.register(
            name="get_email_headers",
            description="Get complete email headers for technical analysis",
            input_schema={
                "type": "object",
                "properties": {
                    "email_id": {"type": "string", "description": "Email ID to get headers for"}
                },
                "required": ["email_id"]
            },
            handler=self.get_email_headers
        )

        # Export/Import
        self.tool_registry.register(
            name="export_emails",
            description="Export emails to file for backup",
            input_schema={
                "type": "object",
                "properties": {
                    "folder": {"type": "string", "description": "Specific folder to export (mutually exclusive with export_all_folders)"},
                    "export_path": {"type": "string", "description": "Path where to save the export file", "default": "emails_export.json"},
                    "max_emails": {"type": "integer", "description": "Maximum number of emails to export (optional, exports all if not specified)"},
                    "export_all_folders": {"type": "boolean", "description": "Export from all folders instead of just one", "default": False}
                },
                "required": []
            },
            handler=self.export_emails
        )

        self.tool_registry.register(
            name="import_emails",
            description="Import emails from backup file to IMAP server",
            input_schema={
                "type": "object",
                "properties": {
                    "import_path": {"type": "string", "description": "Path to import file (.json or .eml) or a directory"},
                    "target_folder": {"type": "string", "description": "Target folder for imported emails (if preserve_folders=False)"},
                    "preserve_folders": {"type": "boolean", "description": "Whether to preserve original folder structure", "default": True}
                },
                "required": ["import_path"]
            },
            handler=self.import_emails
        )

        # Attachments
        self.tool_registry.register(
            name="download_attachment",
            description="Download email attachment information",
            input_schema={
                "type": "object",
                "properties": {
                    "email_id": {"type": "string", "description": "Email ID containing the attachment"},
                    "attachment_filename": {"type": "string", "description": "Name of attachment to download"}
                },
                "required": ["email_id", "attachment_filename"]
            },
            handler=self.download_attachment
        )

    async def list_tools(self):
        """List all available tools"""
        return self.tool_registry.get_tool_definitions()

    async def call_tool(self, name: str, arguments: dict):
        """Handle tool calls using the registry"""
        # Perform delayed auto-login on first tool call (after MCP is fully connected)
        if self._pending_login_email and self._pending_login_password and not self.auto_login_user:
            try:
                self._auto_login(self._pending_login_email, self._pending_login_password)
                # Clear credentials after login
                self._pending_login_email = None
                self._pending_login_password = None
            except Exception as e:
                print(f"Warning: Delayed auto-login failed: {e}", file=sys.stderr)
        
        return await self.tool_registry.call_tool(name, arguments)

    # Tool handlers

    # Authentication handlers
    async def login(self, args: dict):
        """Login user"""
        try:
            result = self.db.login(args["email"], args["password"])
            return self.create_json_response(result)
        except Exception as e:
            return self.create_text_response(f"Login failed: {str(e)}")

    async def logout(self, args: dict):
        """Logout user"""
        try:
            result = self.db.logout()
            return self.create_json_response(result)
        except Exception as e:
            return self.create_text_response(f"Logout failed: {str(e)}")

    async def get_current_user(self, args: dict):
        """Get current user"""
        try:
            user = self.db.get_current_user()
            if user:
                return self.create_json_response(user)
            else:
                return self.create_text_response("No user is currently logged in")
        except Exception as e:
            return self.create_text_response(f"Error getting current user: {str(e)}")

    async def list_users(self, args: dict):
        """List all users"""
        try:
            users = self.db.list_users()
            return self.create_json_response({"users": users, "count": len(users)})
        except Exception as e:
            return self.create_text_response(f"Error listing users: {str(e)}")

    async def create_user(self, args: dict):
        """Create a new user"""
        try:
            result = self.db.create_user(
                email=args["email"],
                name=args["name"],
                password=args["password"]
            )
            return self.create_json_response(result)
        except Exception as e:
            return self.create_text_response(f"Error creating user: {str(e)}")

    async def check_connection(self, args: dict):
        """Check connection"""
        try:
            data = self.db.check_connection()
            return self.create_text_response("Connection Status:\nIMAP: ✓ Connected\nSMTP: ✓ Connected\n\nAll connections are working properly")
        except Exception as e:
            return self.create_text_response(f"Connection check failed: {str(e)}")

    async def get_folders(self, args: dict):
        """Get folders"""
        try:
            folders = self.db.get_folders()
            output = "Available folders:\n"
            for i, folder in enumerate(folders, 1):
                output += f"{i}. {folder['name']} ({folder['total']} total, {folder['unread']} unread)\n"
            return self.create_text_response(output)
        except Exception as e:
            return self.create_text_response(f"Error getting folders: {str(e)}")

    async def create_folder(self, args: dict):
        """Create folder"""
        try:
            folder = self.db.create_folder(args["folder_name"])
            return self.create_text_response(f"Folder '{folder['name']}' created successfully")
        except Exception as e:
            return self.create_text_response(f"Error creating folder: {str(e)}")

    async def delete_folder(self, args: dict):
        """Delete folder"""
        try:
            self.db.delete_folder(args["folder_name"])
            return self.create_text_response(f"Folder '{args['folder_name']}' deleted successfully")
        except Exception as e:
            return self.create_text_response(f"Error deleting folder: {str(e)}")

    async def get_emails(self, args: dict):
        """Get emails"""
        try:
            folder = args.get("folder", "INBOX")
            page = args.get("page", 1)
            page_size = args.get("page_size", 20)

            data = self.db.get_emails(folder, page, page_size)
            return self.create_json_response(data)
        except Exception as e:
            return self.create_text_response(f"Error getting emails: {str(e)}")

    async def read_email(self, args: dict):
        """Read email"""
        try:
            email = self.db.read_email(args["email_id"])
            if not email:
                return self.create_text_response(f"Email not found: {args['email_id']}")
            return self.create_json_response(email)
        except Exception as e:
            return self.create_text_response(f"Error reading email: {str(e)}")

    async def search_emails(self, args: dict):
        """Search emails"""
        try:
            query = args["query"]
            folder = args.get("folder", "INBOX")
            page = args.get("page", 1)
            page_size = args.get("page_size", 20)

            data = self.db.search_emails(query, folder, page, page_size)
            return self.create_json_response(data)
        except Exception as e:
            return self.create_text_response(f"Error searching emails: {str(e)}")

    async def send_email(self, args: dict):
        """Send email"""
        try:
            email = self.db.send_email(
                to=args["to"],
                subject=args["subject"],
                body=args["body"],
                html_body=args.get("html_body"),
                cc=args.get("cc"),
                bcc=args.get("bcc"),
                attachments=args.get("attachments")
            )
            return self.create_json_response(email)
        except Exception as e:
            return self.create_text_response(f"Error sending email: {str(e)}")

    async def reply_email(self, args: dict):
        """Reply to email"""
        try:
            email = self.db.reply_email(
                email_id=args["email_id"],
                body=args["body"],
                html_body=args.get("html_body"),
                cc=args.get("cc"),
                bcc=args.get("bcc"),
                reply_all=args.get("reply_all", False)
            )
            return self.create_json_response(email)
        except Exception as e:
            return self.create_text_response(f"Error replying to email: {str(e)}")

    async def forward_email(self, args: dict):
        """Forward email"""
        try:
            email = self.db.forward_email(
                email_id=args["email_id"],
                to=args["to"],
                body=args.get("body"),
                html_body=args.get("html_body"),
                cc=args.get("cc"),
                bcc=args.get("bcc")
            )
            return self.create_json_response(email)
        except Exception as e:
            return self.create_text_response(f"Error forwarding email: {str(e)}")

    async def delete_email(self, args: dict):
        """Delete email"""
        try:
            self.db.delete_email(args["email_id"])
            return self.create_text_response(f"Email {args['email_id']} deleted successfully")
        except Exception as e:
            return self.create_text_response(f"Error deleting email: {str(e)}")

    async def move_email(self, args: dict):
        """Move email"""
        try:
            email = self.db.move_email(args["email_id"], args["target_folder"])
            return self.create_json_response(email)
        except Exception as e:
            return self.create_text_response(f"Error moving email: {str(e)}")

    async def mark_emails(self, args: dict):
        """Mark emails"""
        try:
            emails = self.db.mark_emails(args["email_ids"], args["status"])
            return self.create_json_response({"updated_emails": emails, "count": len(emails)})
        except Exception as e:
            return self.create_text_response(f"Error marking emails: {str(e)}")

    async def move_emails(self, args: dict):
        """Move emails"""
        try:
            emails = self.db.move_emails(args["email_ids"], args["target_folder"])
            return self.create_json_response({"moved_emails": emails, "count": len(emails)})
        except Exception as e:
            return self.create_text_response(f"Error moving emails: {str(e)}")

    async def delete_emails(self, args: dict):
        """Delete emails"""
        try:
            self.db.delete_emails(args["email_ids"])
            return self.create_text_response(f"Successfully deleted {len(args['email_ids'])} emails")
        except Exception as e:
            return self.create_text_response(f"Error deleting emails: {str(e)}")

    async def save_draft(self, args: dict):
        """Save draft"""
        try:
            draft = self.db.save_draft(
                subject=args["subject"],
                body=args["body"],
                html_body=args.get("html_body"),
                to=args.get("to"),
                cc=args.get("cc"),
                bcc=args.get("bcc")
            )
            return self.create_json_response(draft)
        except Exception as e:
            return self.create_text_response(f"Error saving draft: {str(e)}")

    async def get_drafts(self, args: dict):
        """Get drafts"""
        try:
            page = args.get("page", 1)
            page_size = args.get("page_size", 20)
            data = self.db.get_drafts(page, page_size)
            return self.create_json_response(data)
        except Exception as e:
            return self.create_text_response(f"Error getting drafts: {str(e)}")

    async def update_draft(self, args: dict):
        """Update draft"""
        try:
            draft_id = args.pop("draft_id")
            draft = self.db.update_draft(draft_id, args)
            return self.create_json_response(draft)
        except Exception as e:
            return self.create_text_response(f"Error updating draft: {str(e)}")

    async def delete_draft(self, args: dict):
        """Delete draft"""
        try:
            self.db.delete_draft(args["draft_id"])
            return self.create_text_response(f"Draft {args['draft_id']} deleted successfully")
        except Exception as e:
            return self.create_text_response(f"Error deleting draft: {str(e)}")

    async def get_mailbox_stats(self, args: dict):
        """Get mailbox stats"""
        try:
            folder_name = args.get("folder_name")
            stats = self.db.get_mailbox_stats(folder_name)
            return self.create_json_response(stats)
        except Exception as e:
            return self.create_text_response(f"Error getting mailbox stats: {str(e)}")

    async def get_unread_count(self, args: dict):
        """Get unread count"""
        try:
            folder_name = args.get("folder_name")
            count = self.db.get_unread_count(folder_name)
            return self.create_text_response(f"Total unread messages: {count}")
        except Exception as e:
            return self.create_text_response(f"Error getting unread count: {str(e)}")

    async def get_email_headers(self, args: dict):
        """Get email headers"""
        try:
            headers = self.db.get_email_headers(args["email_id"])
            return self.create_json_response(headers)
        except Exception as e:
            return self.create_text_response(f"Error getting email headers: {str(e)}")

    async def export_emails(self, args: dict):
        """Export emails"""
        try:
            export_path = args.get("export_path", "emails_export.json")
            emails = self.db.export_emails(
                folder=args.get("folder"),
                export_all_folders=args.get("export_all_folders", False),
                max_emails=args.get("max_emails")
            )

            # Save to file
            import json
            os.makedirs(os.path.dirname(export_path) if os.path.dirname(export_path) else ".", exist_ok=True)
            with open(export_path, 'w') as f:
                json.dump(emails, f, indent=2)

            return self.create_text_response(f"Successfully exported {len(emails)} emails to {export_path}")
        except Exception as e:
            return self.create_text_response(f"Error exporting emails: {str(e)}")

    async def import_emails(self, args: dict):
        """Import emails"""
        try:
            import_path = args["import_path"]

            # Load emails from file
            import json
            if os.path.isdir(import_path):
                # Import from directory of .eml files (not fully implemented, just handle JSON for now)
                return self.create_text_response("Directory import not yet fully implemented. Please use JSON file.")
            else:
                with open(import_path, 'r') as f:
                    emails_data = json.load(f)

                # Handle both list and single email
                if not isinstance(emails_data, list):
                    emails_data = [emails_data]

            count = self.db.import_emails(
                emails_data=emails_data,
                target_folder=args.get("target_folder"),
                preserve_folders=args.get("preserve_folders", True)
            )
            return self.create_text_response(f"Successfully imported {count} emails from {import_path}")
        except Exception as e:
            return self.create_text_response(f"Error importing emails: {str(e)}")

    async def download_attachment(self, args: dict):
        """Download attachment"""
        try:
            attachment = self.db.download_attachment(
                email_id=args["email_id"],
                attachment_filename=args["attachment_filename"]
            )
            return self.create_json_response(attachment)
        except Exception as e:
            return self.create_text_response(f"Error downloading attachment: {str(e)}")


async def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(description='Email MCP Server')
    parser.add_argument('--email', type=str, help='Email address for auto-login')
    parser.add_argument('--password', type=str, help='Email password for auto-login')
    args = parser.parse_args()

    server = EmailMCPServer(email=args.email, password=args.password)
    await server.run()


if __name__ == "__main__":
    asyncio.run(main())
