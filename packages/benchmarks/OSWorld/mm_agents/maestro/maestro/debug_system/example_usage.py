"""
Debug System Usage Example
"""

from .main_debugger import create_debugger


def main():
    """Main function - Demonstrate the usage of debug system"""
    
    # Create debugger
    debugger = create_debugger()
    
    print("=== Agent Debug System ===")
    print("This system allows you to restore state from snapshots and debug various components")
    
    # List available snapshots
    snapshots = debugger.list_snapshots() # type: ignore
    if snapshots:
        print(f"\nFound {len(snapshots)} snapshots:")
        for snapshot in snapshots:
            print(f"  - {snapshot}")
        
        # Show information of the first snapshot
        first_snapshot = snapshots[0]
        debugger.show_snapshot_info(first_snapshot) # type: ignore
        debugger.debug_worker_from_snapshot(first_snapshot) # type: ignore
        
    else:
        print("No available snapshots")
        print("Please run the system first to create some snapshots")
    
    # Start interactive debug mode
    print("\nStarting interactive debug mode...")
    debugger.interactive_debug() # type: ignore


if __name__ == "__main__":
    main()