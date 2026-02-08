import asyncio
import computeruse
import logging

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")


async def open_gmail_compose(
    desktop: computeruse.Desktop, recipient: str, subject: str, body: str
):
    """
    Opens Gmail compose window and fills in email details.

    Args:
        desktop: computeruse.Desktop instance
        recipient: Email address to send to
        subject: Subject of the email
        body: Body content of the email
    """
    try:
        # Open Gmail in default browser
        gmail_url = "https://mail.google.com/mail/u/0/#inbox?compose=new"
        logging.info("Opening Gmail compose window...")
        desktop.open_url(gmail_url)

        # Wait for the page to load
        await asyncio.sleep(10)  # Adjust this based on your internet speed

        # Get the Gmail window
        gmail_window = desktop.locator("window:Gmail")
        document = gmail_window.locator("role:Document")

        # Find and fill recipient field
        recipient_field = await document.locator("name:To recipients").first()
        recipient_field.highlight(color=0x00FF00, duration_ms=2000)  # Green highlight
        recipient_field.type_text(recipient)
        await asyncio.sleep(1)

        # Find and fill subject field
        subject_field = await document.locator("name:Subject").first()
        subject_field.highlight(color=0x0000FF, duration_ms=2000)  # Blue highlight
        subject_field.type_text(subject)
        await asyncio.sleep(1)

        # Find and fill body field
        body_field = await document.locator("name:Message Body").first()
        body_field.highlight(color=0xFF00FF, duration_ms=2000)  # Magenta highlight
        body_field.type_text(body)
        await asyncio.sleep(1)

        logging.info("Email composed successfully!")

        # Find and click the Send button
        send_button = await document.locator("name:(Ctrl-Enter)").first()
        send_button.highlight(color=0xFFFF00, duration_ms=2000)  # Yellow highlight
        send_button.click()
        await asyncio.sleep(1)

        logging.info("Email sent successfully!")

        # Navigate to Sent folder
        sent_button = await document.locator("name:Labels").locator("name:Sent").first()
        sent_button.highlight(color=0x00FFFF, duration_ms=2000)  # Cyan highlight
        sent_button.click()
        await asyncio.sleep(2)

        # Open the sent email
        grid_item = (
            await document.locator("role:DataGrid").locator("role:DataItem").first()
        )
        grid_item.highlight(color=0xFFA500, duration_ms=2000)  # Orange highlight
        grid_item.click()

        logging.info("Email opened successfully!")

    except computeruse.PlatformError as e:
        logging.error(f"Platform Error: {e}")
        raise
    except Exception as e:
        logging.error(f"An unexpected error occurred: {e}")
        raise


async def main():
    desktop = computeruse.Desktop(log_level="error")  # Suppress info logs

    # Email details
    recipient = "ansh@gmail.com"  # Replace with actual recipient
    subject = "Le ComputerUse est immortel."
    body = "This is a test email sent using ComputerUse automation."

    try:
        await open_gmail_compose(desktop, recipient, subject, body)
    except Exception as e:
        logging.error(f"Failed to compose email: {e}")
        raise


if __name__ == "__main__":
    asyncio.run(main())
