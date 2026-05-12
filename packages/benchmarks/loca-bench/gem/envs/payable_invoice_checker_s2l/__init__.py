"""Payable Invoice Checker S2L Environment.

This environment simulates a financial scenario where an agent needs to:
1. Extract invoice data from PDF files
2. Update Snowflake database tables (INVOICES and INVOICE_PAYMENTS)
3. Send email notifications to purchasing managers for unpaid invoices
4. Set proper column descriptions in the database

The environment supports multiple difficulty levels and parallel execution.
"""

from .payable_invoice_checker_s2l import PayableInvoiceCheckerS2LEnv

__all__ = ["PayableInvoiceCheckerS2LEnv"]



