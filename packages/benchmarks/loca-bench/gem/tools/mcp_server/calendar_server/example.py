"""
Example script demonstrating Calendar MCP Tool usage.

This example shows:
1. How to create the tool using stdio mode (auto-starts server)
2. How to list available tools
3. How to execute various Calendar operations:
   - Create events
   - List events
   - Get event details
   - Update events
   - Delete events

Usage:
    python example.py
"""

from gem.tools.mcp_server.calendar import create_calendar_tool_stdio
from datetime import datetime, timedelta


def main():
    print("=" * 80)
    print("Calendar MCP Tool Example")
    print("=" * 80)
    
    # Create the tool using stdio mode (auto-starts server)
    print("\n1. Creating Calendar MCP Tool (stdio mode)...")
    tool = create_calendar_tool_stdio(
        data_dir="./calendar_data",
        validate_on_init=False
    )
    print("✓ Tool created successfully")
    
    # List available tools
    print("\n2. Listing available tools...")
    tools = tool.get_available_tools()
    print(f"✓ Found {len(tools)} tools:")
    for tool_dict in tools:
        print(f"  - {tool_dict['name']}: {tool_dict.get('description', 'No description')[:60]}...")
    
    # Example 1: Create an event
    print("\n3. Example: Create a calendar event...")
    # Use current date + 7 days for the event
    start_time = (datetime.now() + timedelta(days=7)).replace(hour=10, minute=0, second=0)
    end_time = start_time + timedelta(hours=1)
    
    action = f'''<tool_call>
<tool_name>create_event</tool_name>
<parameters>
<summary>Team Meeting</summary>
<start>
  <dateTime>{start_time.isoformat()}</dateTime>
  <timeZone>UTC</timeZone>
</start>
<end>
  <dateTime>{end_time.isoformat()}</dateTime>
  <timeZone>UTC</timeZone>
</end>
<description>Weekly team sync meeting</description>
<location>Conference Room A</location>
</parameters>
</tool_call>'''
    
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    
    print(f"  Valid: {is_valid}, Has Error: {has_error}")
    if is_valid and not has_error:
        print("✓ Success: Event created")
        print(f"  {obs[:300]}..." if len(obs) > 300 else f"  {obs}")
        # Extract event ID if possible
        event_id = None
        if parsed and isinstance(parsed, list) and len(parsed) > 0:
            event_data = parsed[0]
            if isinstance(event_data, dict):
                event_id = event_data.get('id')
                print(f"  Event ID: {event_id}")
    else:
        print(f"✗ Error: {obs}")
    
    # Example 2: List events
    print("\n4. Example: List calendar events...")
    # List events for the next month
    time_min = datetime.now().isoformat() + "Z"
    time_max = (datetime.now() + timedelta(days=30)).isoformat() + "Z"
    
    action = f'''<tool_call>
<tool_name>list_events</tool_name>
<parameters>
<timeMin>{time_min}</timeMin>
<timeMax>{time_max}</timeMax>
<maxResults>10</maxResults>
<orderBy>startTime</orderBy>
</parameters>
</tool_call>'''
    
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    
    print(f"  Valid: {is_valid}, Has Error: {has_error}")
    if is_valid and not has_error:
        print("✓ Success: Events listed")
        print(f"  {obs[:300]}..." if len(obs) > 300 else f"  {obs}")
        # Extract event IDs from response if possible
        event_ids = []
        if parsed and isinstance(parsed, list):
            for item in parsed:
                if isinstance(item, dict):
                    items = item.get('items', [])
                    for event in items:
                        if isinstance(event, dict) and 'id' in event:
                            event_ids.append(event['id'])
        
        # Use the first event ID for subsequent examples
        if event_ids:
            event_id = event_ids[0]
            print(f"  Found {len(event_ids)} events, using first: {event_id}")
            
            # Example 3: Get event details
            print("\n5. Example: Get event details...")
            action = f'''<tool_call>
<tool_name>get_event</tool_name>
<parameters>
<eventId>{event_id}</eventId>
</parameters>
</tool_call>'''
            
            is_valid, has_error, obs, parsed = tool.execute_action(action)
            
            print(f"  Valid: {is_valid}, Has Error: {has_error}")
            if is_valid and not has_error:
                print("✓ Success: Event details retrieved")
                print(f"  {obs[:300]}..." if len(obs) > 300 else f"  {obs}")
            else:
                print(f"✗ Error: {obs}")
            
            # Example 4: Update event
            print("\n6. Example: Update event...")
            new_start = (datetime.now() + timedelta(days=7)).replace(hour=14, minute=0, second=0)
            new_end = new_start + timedelta(hours=1, minutes=30)
            
            action = f'''<tool_call>
<tool_name>update_event</tool_name>
<parameters>
<eventId>{event_id}</eventId>
<summary>Updated: Team Meeting</summary>
<start>
  <dateTime>{new_start.isoformat()}</dateTime>
  <timeZone>UTC</timeZone>
</start>
<end>
  <dateTime>{new_end.isoformat()}</dateTime>
  <timeZone>UTC</timeZone>
</end>
<description>Updated weekly team sync meeting with extended time</description>
<location>Conference Room B</location>
</parameters>
</tool_call>'''
            
            is_valid, has_error, obs, parsed = tool.execute_action(action)
            
            print(f"  Valid: {is_valid}, Has Error: {has_error}")
            if is_valid and not has_error:
                print("✓ Success: Event updated")
                print(f"  {obs[:300]}..." if len(obs) > 300 else f"  {obs}")
            else:
                print(f"✗ Error: {obs}")
            
            # Example 5: Delete event
            print("\n7. Example: Delete event...")
            action = f'''<tool_call>
<tool_name>delete_event</tool_name>
<parameters>
<eventId>{event_id}</eventId>
</parameters>
</tool_call>'''
            
            is_valid, has_error, obs, parsed = tool.execute_action(action)
            
            print(f"  Valid: {is_valid}, Has Error: {has_error}")
            if is_valid and not has_error:
                print("✓ Success: Event deleted")
                print(f"  {obs}")
            else:
                print(f"✗ Error: {obs}")
        else:
            print("  No events found to demonstrate get/update/delete operations")
    else:
        print(f"✗ Error: {obs}")
    
    print("\n" + "=" * 80)
    print("Example completed!")
    print("=" * 80)


if __name__ == "__main__":
    main()











