#!/usr/bin/env python3
"""
Generate test vendor invoice PDF files
"""

from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
import os
import random
import json
from datetime import datetime

# fix random seed, so that the generated invoices are deterministic
random.seed(42)

# Global set to track used invoice IDs for uniqueness
USED_INVOICE_IDS = set()

def generate_unique_invoice_id_for_real_invoices(index):
    """Generate unique invoice ID for real invoices"""
    max_attempts = 1000  # Prevent infinite loops
    attempt = 0

    while attempt < max_attempts:
        # Real invoice formats
        real_formats = [
            f"INV-2024-{random.randint(1, 2000):03d}",
            f"2024-{random.randint(1000, 9999)}",
            f"MCP-{random.randint(100000, 999999)}",
            f"PO{random.randint(10000, 99999)}-24",
            f"BL-2024-{random.randint(100, 999)}",
            f"REF{random.randint(1000, 9999)}24",
            f"INV{random.randint(100000, 999999)}"
        ]
        invoice_id = random.choice(real_formats)

        # Check if already exists
        if invoice_id not in USED_INVOICE_IDS:
            USED_INVOICE_IDS.add(invoice_id)
            return invoice_id

        attempt += 1

    # If unable to generate unique ID after many attempts, use timestamp
    import time
    timestamp = int(time.time() * 1000)
    unique_id = f"REAL-{timestamp}-{random.randint(1000, 9999)}"
    USED_INVOICE_IDS.add(unique_id)
    return unique_id

def register_fonts():
    """Register multiple fonts for PDF generation"""
    fonts = {
        'main': 'Helvetica',
        'title': 'Helvetica-Bold',
        'mono': 'Courier'
    }
    
    try:
        # Try to register additional fonts
        font_configs = [
            ('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 'DejaVuSans'),
            ('/System/Library/Fonts/Times.ttc', 'Times'),
            ('/System/Library/Fonts/Geneva.ttf', 'Geneva'),
            ('/Windows/Fonts/times.ttf', 'Times'),
            ('/Windows/Fonts/arial.ttf', 'Arial'),
        ]
        
        for font_path, font_name in font_configs:
            if os.path.exists(font_path):
                try:
                    pdfmetrics.registerFont(TTFont(font_name, font_path))
                    fonts['main'] = font_name
                    break
                except Exception:
                    continue
                    
    except Exception as e:
        print(f"Font registration info: {e}")
    
    return fonts

# PDF Template Styles
TEMPLATE_STYLES = {
    'government': {
        'title_size': 20,
        'header_size': 12,
        'body_size': 10,
        'line_spacing': 18,
        'colors': {'title': (0.2, 0.2, 0.6), 'header': (0.1, 0.1, 0.1), 'body': (0, 0, 0)},
        'layout': 'formal'
    },
    'modern': {
        'title_size': 24,
        'header_size': 14, 
        'body_size': 11,
        'line_spacing': 20,
        'colors': {'title': (0.1, 0.4, 0.7), 'header': (0.3, 0.3, 0.3), 'body': (0.2, 0.2, 0.2)},
        'layout': 'clean'
    },
    'traditional': {
        'title_size': 18,
        'header_size': 12,
        'body_size': 10,
        'line_spacing': 16,
        'colors': {'title': (0, 0, 0), 'header': (0, 0, 0), 'body': (0, 0, 0)},
        'layout': 'classic'
    },
    'corporate': {
        'title_size': 22,
        'header_size': 13,
        'body_size': 10,
        'line_spacing': 19,
        'colors': {'title': (0.8, 0.1, 0.1), 'header': (0.2, 0.2, 0.2), 'body': (0.1, 0.1, 0.1)},
        'layout': 'professional'
    },
    'minimalist': {
        'title_size': 16,
        'header_size': 11,
        'body_size': 9,
        'line_spacing': 15,
        'colors': {'title': (0.4, 0.4, 0.4), 'header': (0.3, 0.3, 0.3), 'body': (0.2, 0.2, 0.2)},
        'layout': 'simple'
    },
    'tabular': {
        'title_size': 14,
        'header_size': 10,
        'body_size': 8,
        'line_spacing': 12,
        'colors': {'title': (0, 0, 0), 'header': (0, 0, 0), 'body': (0, 0, 0)},
        'layout': 'table_format'
    }
}

def create_invoice_pdf(filename, invoice_data, template_style='government'):
    """Create invoice PDF with specified template style"""
    c = canvas.Canvas(filename, pagesize=A4)
    _, height = A4
    
    # Register fonts and get style
    fonts = register_fonts()
    style = TEMPLATE_STYLES[template_style]
    
    # Set title with style
    c.setFont(fonts['title'], style['title_size'])
    c.setFillColorRGB(*style['colors']['title'])
    
    if style['layout'] == 'government':
        # Government style - centered title with underline
        title_text = "ACCOUNTS PAYABLE INVOICE REPORT"
        text_width = c.stringWidth(title_text, fonts['title'], style['title_size'])
        c.drawString((595 - text_width) / 2, height - 60, title_text)
        c.line((595 - text_width) / 2, height - 70, (595 + text_width) / 2, height - 70)
        y_pos = height - 100
    elif style['layout'] == 'modern':
        # Modern style - large title with accent
        c.drawString(50, height - 50, "INVOICE")
        c.setFillColorRGB(0.9, 0.9, 0.9)
        c.rect(40, height - 80, 520, 2, fill=1)
        y_pos = height - 110
    elif style['layout'] == 'traditional':
        # Traditional style - formal header
        c.drawString(50, height - 40, "COMMERCIAL INVOICE")
        c.line(50, height - 50, 545, height - 50)
        y_pos = height - 80
    elif style['layout'] == 'professional':
        # Corporate style - bold header with box
        c.setFillColorRGB(0.95, 0.95, 0.95)
        c.rect(40, height - 80, 520, 40, fill=1)
        c.setFillColorRGB(*style['colors']['title'])
        c.drawString(50, height - 65, "INVOICE")
        y_pos = height - 110
    elif style['layout'] == 'table_format':
        # Tabular style - compact header with table-like layout
        c.drawString(50, height - 30, "INVOICE REPORT")
        c.line(50, height - 35, 200, height - 35)
        y_pos = height - 60
    else:  # minimalist
        # Simple clean title
        c.drawString(50, height - 40, "Invoice")
        y_pos = height - 70
    
    # Invoice basic information with style
    c.setFillColorRGB(*style['colors']['header'])
    c.setFont(fonts['main'], style['header_size'])
    
    if template_style == 'government':
        # Government format - more formal layout
        c.drawString(50, y_pos, f"Document ID: {invoice_data['invoice_id']}")
        c.drawString(350, y_pos, f"Processing Date: {invoice_data['date']}")
        y_pos -= style['line_spacing']
        c.drawString(50, y_pos, f"Department: Accounts Payable")
        y_pos -= style['line_spacing'] * 1.5
    elif template_style == 'tabular':
        # Tabular format - compact information in table style
        c.drawString(50, y_pos, f"Invoice: {invoice_data['invoice_id']}")
        c.drawString(250, y_pos, f"Date: {invoice_data['date']}")
        c.drawString(400, y_pos, f"Amount: ${invoice_data['total_amount']:.2f}")
        y_pos -= style['line_spacing'] * 1.5
    else:
        # Standard format
        c.drawString(50, y_pos, f"Invoice ID: {invoice_data['invoice_id']}")
        c.drawString(350, y_pos, f"Date: {invoice_data['date']}")
        y_pos -= style['line_spacing'] * 1.5
    
    # Supplier information with style
    c.setFont(fonts['title'], style['header_size'])
    c.setFillColorRGB(*style['colors']['header'])
    
    if template_style == 'government':
        c.drawString(50, y_pos, "VENDOR INFORMATION:")
    elif template_style == 'tabular':
        c.drawString(50, y_pos, "Vendor:")
    else:
        c.drawString(50, y_pos, "Supplier:")
    
    y_pos -= style['line_spacing']
    c.setFont(fonts['main'], style['body_size'])
    c.setFillColorRGB(*style['colors']['body'])
    
    if template_style == 'tabular':
        # More compact vendor info for tabular format
        c.drawString(50, y_pos, invoice_data['supplier'])
        y_pos -= 12
        c.drawString(50, y_pos, invoice_data['supplier_address'])
        y_pos -= style['line_spacing'] * 1.5
    else:
        c.drawString(50, y_pos, invoice_data['supplier'])
        c.drawString(50, y_pos - 15, invoice_data['supplier_address'])
        y_pos -= style['line_spacing'] * 2.5
    
    # Bill to information with style
    c.setFont(fonts['title'], style['header_size'])
    c.setFillColorRGB(*style['colors']['header'])
    
    if template_style == 'government':
        c.drawString(300, y_pos + style['line_spacing'] * 2.5, "DEPARTMENT INFORMATION:")
    elif template_style == 'tabular':
        c.drawString(300, y_pos + style['line_spacing'], "Bill To:")
    else:
        c.drawString(300, y_pos + style['line_spacing'] * 2.5, "Bill To:")
    
    c.setFont(fonts['main'], style['body_size'])
    c.setFillColorRGB(*style['colors']['body'])
    
    if template_style == 'tabular':
        # More compact billing info for tabular format
        c.drawString(350, y_pos + style['line_spacing'] * 1.5, "Purchasing Dept")
        c.drawString(350, y_pos + style['line_spacing'] * 1.5 - 12, f"{invoice_data['buyer_email']}")
    else:
        c.drawString(300, y_pos + style['line_spacing'], "Purchasing Department")
        c.drawString(300, y_pos + style['line_spacing'] - 15, f"Contact: {invoice_data['buyer_email']}")
    
    # Item details with styled table
    c.setFont(fonts['title'], style['header_size'])
    c.setFillColorRGB(*style['colors']['header'])
    
    if template_style == 'government':
        c.drawString(50, y_pos, "LINE ITEMS:")
    elif template_style == 'tabular':
        c.drawString(50, y_pos, "ITEMS:")
    else:
        c.drawString(50, y_pos, "Items:")
    y_pos -= style['line_spacing'] * 1.5
    
    # Styled table header
    if template_style in ['government', 'corporate', 'tabular']:
        c.setFillColorRGB(0.9, 0.9, 0.9)
        if template_style == 'tabular':
            # Draw a more structured table header for tabular format
            c.rect(45, y_pos - 5, 500, 15, fill=1)
            c.setStrokeColorRGB(0, 0, 0)
            c.rect(45, y_pos - 5, 500, 15, fill=0)
        else:
            c.rect(45, y_pos - 5, 500, style['line_spacing'], fill=1)
    
    c.setFont(fonts['title'], style['body_size'])
    c.setFillColorRGB(*style['colors']['header'])
    
    if template_style == 'tabular':
        # Tabular format - better column alignment
        c.drawString(50, y_pos, "Description")
        c.drawString(300, y_pos, "Qty")
        c.drawString(350, y_pos, "Unit Price")
        c.drawString(450, y_pos, "Total")
    else:
        c.drawString(50, y_pos, "Description")
        c.drawString(250, y_pos, "Qty")
        c.drawString(350, y_pos, "Unit Price")
        c.drawString(450, y_pos, "Total")
    y_pos -= style['line_spacing']
    
    # Item rows with alternating colors for some styles
    c.setFont(fonts['main'], style['body_size'])
    c.setFillColorRGB(*style['colors']['body'])
    
    for i, item in enumerate(invoice_data['items']):
        if template_style in ['modern', 'corporate'] and i % 2 == 1:
            c.setFillColorRGB(0.97, 0.97, 0.97)
            c.rect(45, y_pos - 5, 500, 15, fill=1)
            c.setFillColorRGB(*style['colors']['body'])
        elif template_style == 'tabular':
            # Draw bordered cells for tabular format with better spacing
            c.setStrokeColorRGB(0.5, 0.5, 0.5)
            c.rect(45, y_pos - 5, 245, 15, fill=0)  # Description
            c.rect(290, y_pos - 5, 50, 15, fill=0)  # Qty
            c.rect(340, y_pos - 5, 100, 15, fill=0)  # Unit Price
            c.rect(440, y_pos - 5, 85, 15, fill=0)  # Total
            c.setFillColorRGB(*style['colors']['body'])
        
        if template_style == 'tabular':
            # Adjusted positioning for tabular format
            c.drawString(50, y_pos, item['description'])
            c.drawString(305, y_pos, str(item['quantity']))
            c.drawString(350, y_pos, f"${item['unit_price']:.2f}")
            c.drawString(450, y_pos, f"${item['total']:.2f}")
        else:
            c.drawString(50, y_pos, item['description'])
            c.drawString(250, y_pos, str(item['quantity']))
            c.drawString(350, y_pos, f"${item['unit_price']:.2f}")
            c.drawString(450, y_pos, f"${item['total']:.2f}")
        y_pos -= 15
    
    # Separator line
    y_pos -= 10
    c.line(50, y_pos, 500, y_pos)
    y_pos -= 20
    
    # Total with style
    if template_style in ['government', 'corporate']:
        c.setFillColorRGB(0.95, 0.95, 0.95)
        c.rect(340, y_pos - 10, 200, 25, fill=1)
    
    c.setFont(fonts['title'], style['header_size'])
    c.setFillColorRGB(*style['colors']['title'])
    c.drawString(350, y_pos, f"Total Amount: ${invoice_data['total_amount']:.2f}")
    y_pos -= style['line_spacing'] * 2
    
    # Payment information with style
    c.setFont(fonts['main'], style['body_size'])
    c.setFillColorRGB(*style['colors']['body'])
    
    if template_style == 'government':
        c.drawString(50, y_pos, "Payment Terms: Net 30 days from receipt")
    elif template_style == 'tabular':
        c.drawString(50, y_pos, "Terms: Net 30")
    else:
        c.drawString(50, y_pos, "Payment Terms: Net 30 days")
    y_pos -= 15
    
    if template_style == 'government':
        c.drawString(50, y_pos, f"Wire Transfer Account: {invoice_data['bank_account']}")
    elif template_style == 'tabular':
        c.drawString(50, y_pos, f"Account: {invoice_data['bank_account']}")
    else:
        c.drawString(50, y_pos, f"Bank Account: {invoice_data['bank_account']}")
    y_pos -= style['line_spacing']
    
    # Payment status - only show sometimes (60% chance)
    payment_status = invoice_data.get('payment_status', {})
    show_payment_status = payment_status.get('show_status', True)
    
    if show_payment_status:
        paid_amount = payment_status.get('paid_amount', 0.0)
        status = payment_status.get('status', 'unpaid')
        
        # Enhanced prominent payment status display
        status_font_size = max(style['header_size'] + 4, 16)  # Larger font size
        c.setFont(fonts['title'], status_font_size)
        
        if status == 'paid':
            bg_color = (0.8, 1.0, 0.8)  # Light green background
            text_color = (0.0, 0.5, 0.0)  # Dark green text
            status_text = f"PAYMENT STATUS: ✓ PAID (${paid_amount:.2f})"
            border_color = (0.0, 0.7, 0.0)  # Green border
        elif status == 'partial':
            bg_color = (1.0, 0.95, 0.8)  # Light orange background
            text_color = (0.8, 0.4, 0.0)  # Dark orange text
            status_text = f"PAYMENT STATUS: ⚠ PARTIAL (${paid_amount:.2f} of ${invoice_data['total_amount']:.2f})"
            border_color = (0.9, 0.5, 0.0)  # Orange border
        else:
            bg_color = (1.0, 0.9, 0.9)  # Light red background
            text_color = (0.8, 0.0, 0.0)  # Dark red text
            status_text = "PAYMENT STATUS: ✗ UNPAID"
            border_color = (0.8, 0.0, 0.0)  # Red border
        
        # Calculate text dimensions for proper box sizing
        text_width = c.stringWidth(status_text, fonts['title'], status_font_size)
        box_width = text_width + 20
        box_height = 35
        
        # Draw prominent colored background box
        c.setFillColorRGB(*bg_color)
        c.rect(45, y_pos - 10, box_width, box_height, fill=1)
        
        # Draw border around the status box
        c.setStrokeColorRGB(*border_color)
        c.setLineWidth(2)
        c.rect(45, y_pos - 10, box_width, box_height, fill=0)
        c.setLineWidth(1)  # Reset line width
        
        # Draw the status text
        c.setFillColorRGB(*text_color)
        c.drawString(55, y_pos + 5, status_text)
        
        # Add a secondary line with more details for partial payments
        if status == 'partial':
            remaining = invoice_data['total_amount'] - paid_amount
            detail_text = f"Remaining Balance: ${remaining:.2f}"
            c.setFont(fonts['main'], style['body_size'] + 1)
            c.setFillColorRGB(*text_color)
            c.drawString(55, y_pos - 15, detail_text)
            y_pos -= 50
        else:
            y_pos -= 40
    else:
        # If not showing prominent status, show subtle note based on actual status
        paid_amount = payment_status.get('paid_amount', 0.0)
        status = payment_status.get('status', 'unpaid')
        
        c.setFont(fonts['main'], style['body_size'])
        c.setFillColorRGB(*style['colors']['body'])
        
        if status == 'paid':
            paid_messages = [
                "Payment received and confirmed",
                "Invoice paid in full",
                "Payment completed successfully",
                "Fully settled - Thank you for your payment"
            ]
            message = random.choice(paid_messages)
        elif status == 'partial':
            partial_messages = [
                f"Partial payment received: ${paid_amount:.2f}",
                f"Payment in progress: ${paid_amount:.2f} paid",
                f"Partial settlement: ${paid_amount:.2f} of ${invoice_data['total_amount']:.2f}"
            ]
            message = random.choice(partial_messages)
        else:  # unpaid
            unpaid_messages = [
                "Payment under review",
                "Processing for payment",
                "Pending payment approval",
                "Awaiting payment authorization",
                "Payment verification in process"
            ]
            message = random.choice(unpaid_messages)
        
        c.drawString(50, y_pos, message)
        y_pos -= 15
    
    # Signature area with style - filled with actual information
    c.setFillColorRGB(*style['colors']['body'])
    c.setFont(fonts['main'], style['body_size'])
    
    # Generate random signature information
    approver_names = [
        "Michael Johnson", "Sarah Williams", "David Brown", "Jennifer Davis",
        "Robert Miller", "Lisa Wilson", "James Moore", "Patricia Taylor",
        "Christopher Anderson", "Mary Thomas", "Daniel Jackson", "Linda White"
    ]
    approver_name = random.choice(approver_names)
    
    # Generate signature date (could be same as invoice date or slightly later)
    signature_dates = [invoice_data['date']]  # Same as invoice date
    # Add some dates 1-5 days after invoice date
    invoice_month = int(invoice_data['date'].split('-')[1])
    invoice_day = int(invoice_data['date'].split('-')[2])
    for days_later in range(1, 6):
        new_day = min(invoice_day + days_later, 28)  # Keep it simple, max day 28
        signature_dates.append(f"2024-{invoice_month:02d}-{new_day:02d}")
    
    signature_date = random.choice(signature_dates)
    
    if template_style == 'government':
        c.drawString(50, y_pos, f"Authorized by: {approver_name}")
        c.drawString(350, y_pos, f"Approval Date: {signature_date}")
    elif template_style == 'tabular':
        check_number = f"{random.randint(1000, 9999)}"
        c.drawString(50, y_pos, f"Approved: {approver_name}")
        c.drawString(250, y_pos, f"Date: {signature_date}")
        c.drawString(400, y_pos, f"Check #: {check_number}")
    else:
        c.drawString(50, y_pos, f"Authorized Signature: {approver_name}")
        c.drawString(350, y_pos, f"Date: {signature_date}")
    
    c.save()

# Template configuration - easy to modify
SUPPLIERS_CONFIG = {
    "tech_equipment": {
        "name": "Shanghai Technology Equipment Co., Ltd.",
        "address": "Zhangjiang Hi-Tech Park, Pudong New Area, Shanghai",
        "bank_account": "6228480123456789"
    },
    "office_supplies": {
        "name": "Beijing Office Supplies Vendor",
        "address": "CBD Business District, Chaoyang District, Beijing",
        "bank_account": "6228480987654321"
    },
    "software_services": {
        "name": "Guangzhou Software Services Co., Ltd.",
        "address": "Software Park, Tianhe District, Guangzhou",
        "bank_account": "6228481122334455"
    },
    "logistics": {
        "name": "Shenzhen Logistics Delivery Company",
        "address": "Technology Park, Nanshan District, Shenzhen",
        "bank_account": "6228485566778899"
    },
    "consulting": {
        "name": "Hangzhou Business Consulting Ltd.",
        "address": "West Lake Technology Park, Hangzhou",
        "bank_account": "6228486677889900"
    },
    "manufacturing": {
        "name": "Suzhou Manufacturing Solutions Inc.",
        "address": "Industrial Park, Suzhou New District",
        "bank_account": "6228487788990011"
    }
}

BUYERS_CONFIG = {
    "dcooper@mcp.com": "Dennis Cooper - Purchasing Department",
    "turnerj@mcp.com": "Jose Turner - Purchasing Department", 
    "anthony_murphy24@mcp.com": "Anthony Murphy - Purchasing Department",
    "cturner@mcp.com": "Carol Turner - Purchasing Department",
    "ashley_anderson@mcp.com": "Ashley Anderson - Purchasing Department",
    "brenda_rivera81@mcp.com": "Brenda Rivera - Purchasing Department"
}

ITEMS_TEMPLATES = {
    "tech_equipment": [
        {"description": "Server Equipment", "price_range": (5000, 15000)},
        {"description": "Network Equipment", "price_range": (2000, 8000)},
        {"description": "Storage Systems", "price_range": (3000, 12000)},
        {"description": "Security Hardware", "price_range": (1500, 6000)}
    ],
    "office_supplies": [
        {"description": "Office Desks and Chairs", "price_range": (300, 800)},
        {"description": "Printing Equipment", "price_range": (2000, 5000)},
        {"description": "Office Stationery", "price_range": (100, 500)},
        {"description": "Conference Room Equipment", "price_range": (1000, 3000)}
    ],
    "software_services": [
        {"description": "Software Development Services", "price_range": (15000, 30000)},
        {"description": "Technical Support Services", "price_range": (3000, 8000)},
        {"description": "System Integration", "price_range": (8000, 20000)},
        {"description": "Training Services", "price_range": (2000, 6000)}
    ],
    "logistics": [
        {"description": "Freight Transportation Services", "price_range": (1000, 5000)},
        {"description": "Warehousing Services", "price_range": (800, 3000)},
        {"description": "Express Delivery", "price_range": (200, 1000)},
        {"description": "Packaging Services", "price_range": (300, 1500)}
    ],
    "consulting": [
        {"description": "Business Strategy Consulting", "price_range": (10000, 25000)},
        {"description": "Market Research", "price_range": (5000, 15000)},
        {"description": "Process Optimization", "price_range": (8000, 18000)},
        {"description": "Training and Development", "price_range": (3000, 10000)}
    ],
    "manufacturing": [
        {"description": "Custom Manufacturing", "price_range": (20000, 50000)},
        {"description": "Quality Testing", "price_range": (2000, 8000)},
        {"description": "Product Assembly", "price_range": (5000, 15000)},
        {"description": "Material Supply", "price_range": (3000, 12000)}
    ]
}

def generate_random_payment_status(total_amount):
    """Generate random payment status"""
    # 60% chance to show payment status, 40% chance to hide it
    show_status = random.random() < 0.6
    
    # 70% chance fully paid, 30% chance partially paid or unpaid
    if random.random() < 0.7:
        return {
            "paid_amount": total_amount,
            "status": "paid",
            "flag": 0,
            "show_status": show_status
        }
    else:
        # Partially paid or unpaid
        if random.random() < 0.6:  # 60% of unpaid are partially paid
            paid_ratio = random.uniform(0.1, 0.8)
            paid_amount = round(total_amount * paid_ratio, 2)
        else:  # 40% are completely unpaid
            paid_amount = 0.0
        
        return {
            "paid_amount": paid_amount,
            "status": "unpaid" if paid_amount == 0 else "partial",
            "flag": 1,
            "show_status": show_status
        }

def generate_invoice_items(supplier_type, num_items=None):
    """Generate random invoice items based on supplier type"""
    if num_items is None:
        # Increase item count - now 2 to 6 items per invoice
        num_items = random.randint(2, 6)
    
    items = []
    item_templates = ITEMS_TEMPLATES.get(supplier_type, ITEMS_TEMPLATES["office_supplies"])
    
    # Allow more items than templates by allowing duplicates with slight variations
    available_items = item_templates.copy()
    if num_items > len(item_templates):
        # Add variations of existing items
        extra_items = []
        for template in item_templates:
            # Create variations with slightly different descriptions and prices
            variations = [
                {"description": f"Premium {template['description']}", 
                 "price_range": (template['price_range'][0] * 1.2, template['price_range'][1] * 1.2)},
                {"description": f"Standard {template['description']}", 
                 "price_range": (template['price_range'][0] * 0.8, template['price_range'][1] * 0.8)},
                {"description": f"Bulk {template['description']}", 
                 "price_range": (template['price_range'][0] * 0.7, template['price_range'][1] * 0.9)}
            ]
            extra_items.extend(variations)
        available_items.extend(extra_items)
    
    selected_items = random.sample(available_items, min(num_items, len(available_items)))
    
    for item_template in selected_items:
        quantity = random.randint(1, 15)  # Increased max quantity
        unit_price = random.uniform(*item_template["price_range"])
        unit_price = round(unit_price, 2)
        total = round(quantity * unit_price, 2)
        
        items.append({
            "description": item_template["description"],
            "quantity": quantity,
            "unit_price": unit_price,
            "total": total
        })
    
    return items

def main(save_groundtruth=False, groundtruth_dir="../groundtruth_workspace"):
    """Generate multiple test invoices"""
    # Get the directory of this script and go up one level to get to the task root
    script_dir = os.path.dirname(os.path.abspath(__file__))
    task_root = os.path.dirname(script_dir)  # Go up from preprocess/ to payable-invoice-checker/
    base_dir = os.path.join(task_root, "files")
    
    print(f"DEBUG: script_dir = {script_dir}")
    print(f"DEBUG: task_root = {task_root}")
    print(f"DEBUG: base_dir = {base_dir}")
    
    # Ensure directory exists
    if not os.path.exists(base_dir):
        os.makedirs(base_dir)
    
    # Create groundtruth directory if needed
    if save_groundtruth and not os.path.exists(groundtruth_dir):
        os.makedirs(groundtruth_dir)
    
    # Generate random invoices
    invoices = []
    supplier_types = list(SUPPLIERS_CONFIG.keys())
    buyer_emails = list(BUYERS_CONFIG.keys())
    
    # Generate 15 invoices with random data
    for i in range(1, 16):
        # Random supplier type and buyer
        supplier_type = random.choice(supplier_types)
        supplier_config = SUPPLIERS_CONFIG[supplier_type]
        buyer_email = random.choice(buyer_emails)
        
        # Generate items and calculate total
        items = generate_invoice_items(supplier_type)
        total_amount = sum(item['total'] for item in items)
        
        # Generate payment status
        payment_status = generate_random_payment_status(total_amount)
        
        # Generate random date in 2024
        month = random.randint(1, 12)
        day = random.randint(1, 28)
        date_str = f"2024-{month:02d}-{day:02d}"
        
        # Generate more diverse invoice numbers with uniqueness check
        invoice_id = generate_unique_invoice_id_for_real_invoices(i)
        
        invoice = {
            "invoice_id": invoice_id,
            "date": date_str,
            "supplier": supplier_config["name"],
            "supplier_address": supplier_config["address"],
            "buyer_email": buyer_email,
            "total_amount": total_amount,
            "bank_account": supplier_config["bank_account"],
            "items": items,
            "payment_status": payment_status
        }
        
        invoices.append(invoice)
    
    # Generate PDF files with different templates
    paid_count = 0
    unpaid_count = 0
    template_styles = list(TEMPLATE_STYLES.keys())
    
    for i, invoice in enumerate(invoices):
        # Cycle through different templates to show variety
        template_style = template_styles[i % len(template_styles)]
        
        filename = os.path.join(base_dir, f"{invoice['invoice_id']}.pdf")
        create_invoice_pdf(filename, invoice, template_style)
        
        payment_status = invoice['payment_status']['status']
        show_status = invoice['payment_status'].get('show_status', True)
        
        if payment_status == 'paid':
            paid_count += 1
            status_indicator = "✓"
        else:
            unpaid_count += 1
            status_indicator = "⚠"
        
        # Show payment status info
        status_display = f"{payment_status}" if show_status else "hidden"
        items_count = len(invoice['items'])
        
        print(f"Generated: {filename} [{status_indicator} {status_display}] [{items_count} items] - {template_style} style")
    
    # Save invoice data to groundtruth_workspace/invoice.jsonl if requested
    if save_groundtruth:
        groundtruth_file = os.path.join(groundtruth_dir, "invoice.jsonl")
        with open(groundtruth_file, 'w', encoding='utf-8') as f:
            for invoice in invoices:
                json.dump(invoice, f, ensure_ascii=False)
                f.write('\n')
        print(f"Groundtruth data saved in: {groundtruth_file}")
    
    print(f"\nGenerated {len(invoices)} test invoice PDF files")
    print(f"Payment Status Summary: {paid_count} paid, {unpaid_count} unpaid/partial")
    print("Files saved in:", base_dir)
    
    # Return the invoices data for external use
    return invoices
    
if __name__ == "__main__":
    main(save_groundtruth=True)