"""
Airline domain environment for Tau-bench.

Simulates an airline customer service environment with:
- Flight search and booking
- Reservation management (view, modify, cancel)
- Seat selection
- Baggage handling
- Flight status and delays
"""

from datetime import datetime, timedelta
from typing import Any

from elizaos_tau_bench.types import (
    TauBenchTask,
    ToolCall,
    ToolCallStatus,
    ToolDefinition,
    PolicyConstraint,
    TauDomain,
)
from elizaos_tau_bench.environments.base import DomainEnvironment


class AirlineEnvironment(DomainEnvironment):
    """Simulated airline/travel environment."""

    def __init__(self, task: TauBenchTask) -> None:
        super().__init__(task)
        self.domain = TauDomain.AIRLINE

    async def initialize(self) -> None:
        """Initialize airline environment with mock data."""
        init_data = self.task.initialization_data

        # Default mock database structure
        self.state = {
            "bookings": init_data.get("bookings", {
                "BK-123456": {
                    "booking_id": "BK-123456",
                    "passenger_id": "PAX-001",
                    "passenger_name": "Jane Smith",
                    "email": "jane.smith@example.com",
                    "phone": "+1-555-0456",
                    "flights": [
                        {
                            "flight_id": "FL-AA100",
                            "flight_number": "AA100",
                            "origin": "JFK",
                            "destination": "LAX",
                            "departure": (datetime.now() + timedelta(days=7)).replace(hour=8, minute=30).isoformat(),
                            "arrival": (datetime.now() + timedelta(days=7)).replace(hour=11, minute=45).isoformat(),
                            "cabin_class": "economy",
                            "seat": "24A",
                            "status": "confirmed",
                        },
                        {
                            "flight_id": "FL-AA200",
                            "flight_number": "AA200",
                            "origin": "LAX",
                            "destination": "JFK",
                            "departure": (datetime.now() + timedelta(days=14)).replace(hour=14, minute=0).isoformat(),
                            "arrival": (datetime.now() + timedelta(days=14)).replace(hour=22, minute=30).isoformat(),
                            "cabin_class": "economy",
                            "seat": "24A",
                            "status": "confirmed",
                        },
                    ],
                    "baggage": {
                        "checked_bags": 1,
                        "carry_on": 1,
                    },
                    "total_price": 548.00,
                    "payment_status": "paid",
                    "booking_date": (datetime.now() - timedelta(days=14)).isoformat(),
                    "status": "confirmed",
                    "frequent_flyer": "AA-12345678",
                },
                "BK-123457": {
                    "booking_id": "BK-123457",
                    "passenger_id": "PAX-001",
                    "passenger_name": "Jane Smith",
                    "email": "jane.smith@example.com",
                    "phone": "+1-555-0456",
                    "flights": [
                        {
                            "flight_id": "FL-AA300",
                            "flight_number": "AA300",
                            "origin": "JFK",
                            "destination": "MIA",
                            "departure": (datetime.now() + timedelta(days=30)).replace(hour=10, minute=0).isoformat(),
                            "arrival": (datetime.now() + timedelta(days=30)).replace(hour=13, minute=15).isoformat(),
                            "cabin_class": "business",
                            "seat": "3B",
                            "status": "confirmed",
                        },
                    ],
                    "baggage": {
                        "checked_bags": 2,
                        "carry_on": 1,
                    },
                    "total_price": 892.00,
                    "payment_status": "paid",
                    "booking_date": (datetime.now() - timedelta(days=7)).isoformat(),
                    "status": "confirmed",
                    "frequent_flyer": "AA-12345678",
                },
            }),
            "passengers": init_data.get("passengers", {
                "PAX-001": {
                    "passenger_id": "PAX-001",
                    "name": "Jane Smith",
                    "email": "jane.smith@example.com",
                    "phone": "+1-555-0456",
                    "frequent_flyer": "AA-12345678",
                    "tier": "gold",
                    "miles_balance": 45000,
                    "known_traveler_number": "KTN123456",
                },
            }),
            "flights": init_data.get("flights", {
                "FL-AA100": {
                    "flight_id": "FL-AA100",
                    "flight_number": "AA100",
                    "origin": "JFK",
                    "destination": "LAX",
                    "departure": (datetime.now() + timedelta(days=7)).replace(hour=8, minute=30).isoformat(),
                    "arrival": (datetime.now() + timedelta(days=7)).replace(hour=11, minute=45).isoformat(),
                    "aircraft": "Boeing 777-200",
                    "available_seats": {"economy": 45, "business": 8, "first": 2},
                    "prices": {"economy": 249.00, "business": 649.00, "first": 1299.00},
                    "status": "on_time",
                },
                "FL-AA101": {
                    "flight_id": "FL-AA101",
                    "flight_number": "AA101",
                    "origin": "JFK",
                    "destination": "LAX",
                    "departure": (datetime.now() + timedelta(days=7)).replace(hour=14, minute=0).isoformat(),
                    "arrival": (datetime.now() + timedelta(days=7)).replace(hour=17, minute=15).isoformat(),
                    "aircraft": "Airbus A321",
                    "available_seats": {"economy": 120, "business": 16, "first": 0},
                    "prices": {"economy": 199.00, "business": 549.00},
                    "status": "on_time",
                },
                "FL-AA200": {
                    "flight_id": "FL-AA200",
                    "flight_number": "AA200",
                    "origin": "LAX",
                    "destination": "JFK",
                    "departure": (datetime.now() + timedelta(days=14)).replace(hour=14, minute=0).isoformat(),
                    "arrival": (datetime.now() + timedelta(days=14)).replace(hour=22, minute=30).isoformat(),
                    "aircraft": "Boeing 777-200",
                    "available_seats": {"economy": 32, "business": 4, "first": 1},
                    "prices": {"economy": 299.00, "business": 699.00, "first": 1399.00},
                    "status": "on_time",
                },
                "FL-AA300": {
                    "flight_id": "FL-AA300",
                    "flight_number": "AA300",
                    "origin": "JFK",
                    "destination": "MIA",
                    "departure": (datetime.now() + timedelta(days=30)).replace(hour=10, minute=0).isoformat(),
                    "arrival": (datetime.now() + timedelta(days=30)).replace(hour=13, minute=15).isoformat(),
                    "aircraft": "Airbus A320",
                    "available_seats": {"economy": 80, "business": 12},
                    "prices": {"economy": 149.00, "business": 449.00},
                    "status": "on_time",
                },
            }),
            "seat_maps": init_data.get("seat_maps", {
                "FL-AA100": {
                    "available": ["24B", "24C", "25A", "25B", "25C", "26A", "26B", "26C"],
                    "occupied": ["24A"],  # Jane's current seat
                    "premium": ["10A", "10B", "10C", "11A", "11B", "11C"],
                    "exit_row": ["15A", "15B", "15C"],
                },
            }),
            "policies": {
                "free_cancellation_hours": 24,
                "change_fee": {"economy": 75.00, "business": 50.00, "first": 0.00},
                "cancellation_fee": {"economy": 150.00, "business": 100.00, "first": 0.00},
                "same_day_change_fee": 75.00,
                "baggage_fees": {"first_bag": 35.00, "second_bag": 45.00, "overweight": 100.00},
                "upgrade_available_hours": 72,
            },
            "cancellations": {},
            "changes": {},
        }

        self.initialized = True

    async def execute_tool(self, tool_call: ToolCall) -> Any:
        """Execute an airline domain tool call."""
        self.tool_call_history.append(tool_call)

        tool_handlers = {
            "search_flights": self._search_flights,
            "get_booking_details": self._get_booking_details,
            "get_flight_status": self._get_flight_status,
            "cancel_booking": self._cancel_booking,
            "change_flight": self._change_flight,
            "select_seat": self._select_seat,
            "get_seat_map": self._get_seat_map,
            "add_baggage": self._add_baggage,
            "get_passenger_info": self._get_passenger_info,
            "upgrade_cabin": self._upgrade_cabin,
            "request_special_assistance": self._request_special_assistance,
            "get_boarding_pass": self._get_boarding_pass,
            "check_in": self._check_in,
            "get_policies": self._get_policies,
            "calculate_change_fee": self._calculate_change_fee,
            "list_passenger_bookings": self._list_passenger_bookings,
            "escalate_to_supervisor": self._escalate_to_supervisor,
        }

        handler = tool_handlers.get(tool_call.tool_name)
        if handler:
            try:
                result = await handler(tool_call.arguments)
                tool_call.result = result
                tool_call.status = ToolCallStatus.CORRECT
                return result
            except Exception as e:
                tool_call.status = ToolCallStatus.EXECUTION_ERROR
                tool_call.error_message = str(e)
                return {"error": str(e)}
        else:
            tool_call.status = ToolCallStatus.WRONG_TOOL
            tool_call.error_message = f"Unknown tool: {tool_call.tool_name}"
            return {"error": f"Unknown tool: {tool_call.tool_name}"}

    async def _search_flights(self, args: dict[str, Any]) -> dict[str, Any]:
        """Search for available flights."""
        origin = args.get("origin")
        destination = args.get("destination")
        cabin_class = args.get("cabin_class", "economy")

        if not origin or not destination:
            return {"error": "origin and destination are required"}

        # Find matching flights
        results = []
        for flight in self.state["flights"].values():
            if flight["origin"] == origin and flight["destination"] == destination:
                available = flight["available_seats"].get(cabin_class, 0)
                if available > 0:
                    results.append({
                        "flight_id": flight["flight_id"],
                        "flight_number": flight["flight_number"],
                        "departure": flight["departure"],
                        "arrival": flight["arrival"],
                        "price": flight["prices"].get(cabin_class),
                        "available_seats": available,
                        "cabin_class": cabin_class,
                    })

        return {"flights": results, "count": len(results)}

    async def _get_booking_details(self, args: dict[str, Any]) -> dict[str, Any]:
        """Get detailed booking information."""
        booking_id = args.get("booking_id")
        if not booking_id:
            return {"error": "booking_id is required"}

        booking = self.state["bookings"].get(booking_id)
        if not booking:
            return {"error": f"Booking {booking_id} not found"}

        return booking

    async def _get_flight_status(self, args: dict[str, Any]) -> dict[str, Any]:
        """Get current flight status."""
        flight_id = args.get("flight_id")
        flight_number = args.get("flight_number")

        if not flight_id and not flight_number:
            return {"error": "flight_id or flight_number is required"}

        # Find by flight_id or flight_number
        for flight in self.state["flights"].values():
            if flight["flight_id"] == flight_id or flight["flight_number"] == flight_number:
                return {
                    "flight_id": flight["flight_id"],
                    "flight_number": flight["flight_number"],
                    "status": flight["status"],
                    "departure": flight["departure"],
                    "arrival": flight["arrival"],
                    "origin": flight["origin"],
                    "destination": flight["destination"],
                }

        return {"error": "Flight not found"}

    async def _cancel_booking(self, args: dict[str, Any]) -> dict[str, Any]:
        """Cancel a booking."""
        booking_id = args.get("booking_id")
        reason = args.get("reason", "Customer requested")

        if not booking_id:
            return {"error": "booking_id is required"}

        booking = self.state["bookings"].get(booking_id)
        if not booking:
            return {"error": f"Booking {booking_id} not found"}

        if booking["status"] == "cancelled":
            return {"error": "Booking is already cancelled"}

        # Calculate refund based on time until departure
        first_flight = booking["flights"][0]
        departure = datetime.fromisoformat(first_flight["departure"])
        hours_until = (departure - datetime.now()).total_seconds() / 3600

        # Check free cancellation window
        if hours_until >= self.state["policies"]["free_cancellation_hours"]:
            refund_amount = booking["total_price"]
            cancellation_fee = 0
        else:
            cabin = first_flight["cabin_class"]
            cancellation_fee = self.state["policies"]["cancellation_fee"].get(cabin, 150.00)
            refund_amount = max(0, booking["total_price"] - cancellation_fee)

        # Update booking
        self.state["bookings"][booking_id]["status"] = "cancelled"
        self.state["bookings"][booking_id]["cancelled_at"] = datetime.now().isoformat()
        self.state["bookings"][booking_id]["cancellation_reason"] = reason

        self.state["cancellations"][booking_id] = {
            "booking_id": booking_id,
            "original_amount": booking["total_price"],
            "cancellation_fee": cancellation_fee,
            "refund_amount": refund_amount,
            "cancelled_at": datetime.now().isoformat(),
        }

        return {
            "success": True,
            "booking_id": booking_id,
            "refund_amount": refund_amount,
            "cancellation_fee": cancellation_fee,
            "message": f"Booking cancelled. Refund of ${refund_amount:.2f} will be processed within 7-10 business days.",
        }

    async def _change_flight(self, args: dict[str, Any]) -> dict[str, Any]:
        """Change to a different flight."""
        booking_id = args.get("booking_id")
        old_flight_id = args.get("old_flight_id")
        new_flight_id = args.get("new_flight_id")

        if not booking_id or not new_flight_id:
            return {"error": "booking_id and new_flight_id are required"}

        booking = self.state["bookings"].get(booking_id)
        if not booking:
            return {"error": f"Booking {booking_id} not found"}

        new_flight = self.state["flights"].get(new_flight_id)
        if not new_flight:
            return {"error": f"Flight {new_flight_id} not found"}

        # Find the flight to change
        flight_index = None
        old_flight = None
        for i, f in enumerate(booking["flights"]):
            if f["flight_id"] == old_flight_id or old_flight_id is None:
                flight_index = i
                old_flight = f
                break

        if flight_index is None:
            return {"error": "Flight not found in booking"}
        if old_flight is None:
            return {"error": "Flight not found in booking"}

        # Calculate change fee
        cabin = old_flight["cabin_class"]
        change_fee = self.state["policies"]["change_fee"].get(cabin, 75.00)

        # Calculate fare difference
        old_price = self.state["flights"].get(old_flight["flight_id"], {}).get("prices", {}).get(cabin, 0)
        new_price = new_flight["prices"].get(cabin, 0)
        fare_difference = max(0, new_price - old_price)

        total_charge = change_fee + fare_difference

        # Update booking
        self.state["bookings"][booking_id]["flights"][flight_index] = {
            "flight_id": new_flight_id,
            "flight_number": new_flight["flight_number"],
            "origin": new_flight["origin"],
            "destination": new_flight["destination"],
            "departure": new_flight["departure"],
            "arrival": new_flight["arrival"],
            "cabin_class": cabin,
            "seat": "TBD",  # Seat needs to be reselected
            "status": "confirmed",
        }

        self.state["changes"][f"CHG-{booking_id}"] = {
            "booking_id": booking_id,
            "old_flight": old_flight_id,
            "new_flight": new_flight_id,
            "change_fee": change_fee,
            "fare_difference": fare_difference,
            "total_charge": total_charge,
            "changed_at": datetime.now().isoformat(),
        }

        return {
            "success": True,
            "booking_id": booking_id,
            "new_flight": new_flight_id,
            "change_fee": change_fee,
            "fare_difference": fare_difference,
            "total_charge": total_charge,
            "message": f"Flight changed successfully. Total charge: ${total_charge:.2f}",
        }

    async def _select_seat(self, args: dict[str, Any]) -> dict[str, Any]:
        """Select a seat for a flight."""
        booking_id = args.get("booking_id")
        flight_id = args.get("flight_id")
        seat = args.get("seat")

        if not booking_id or not flight_id or not seat:
            return {"error": "booking_id, flight_id, and seat are required"}

        booking = self.state["bookings"].get(booking_id)
        if not booking:
            return {"error": f"Booking {booking_id} not found"}

        seat_map = self.state["seat_maps"].get(flight_id)
        if not seat_map:
            return {"error": "Seat map not available for this flight"}

        if seat in seat_map["occupied"]:
            return {"error": f"Seat {seat} is already occupied"}

        if seat not in seat_map["available"] and seat not in seat_map.get("premium", []):
            return {"error": f"Seat {seat} is not available"}

        # Update seat
        for flight in booking["flights"]:
            if flight["flight_id"] == flight_id:
                old_seat = flight["seat"]
                flight["seat"] = seat
                # Update seat map
                if old_seat in seat_map["occupied"]:
                    seat_map["occupied"].remove(old_seat)
                    seat_map["available"].append(old_seat)
                if seat in seat_map["available"]:
                    seat_map["available"].remove(seat)
                seat_map["occupied"].append(seat)
                break

        return {
            "success": True,
            "booking_id": booking_id,
            "flight_id": flight_id,
            "seat": seat,
            "message": f"Seat {seat} has been assigned.",
        }

    async def _get_seat_map(self, args: dict[str, Any]) -> dict[str, Any]:
        """Get the seat map for a flight."""
        flight_id = args.get("flight_id")
        if not flight_id:
            return {"error": "flight_id is required"}

        seat_map = self.state["seat_maps"].get(flight_id)
        if not seat_map:
            return {"error": "Seat map not available"}

        return {
            "flight_id": flight_id,
            "available": seat_map["available"],
            "premium_available": seat_map.get("premium", []),
            "exit_row": seat_map.get("exit_row", []),
        }

    async def _add_baggage(self, args: dict[str, Any]) -> dict[str, Any]:
        """Add checked baggage to a booking."""
        booking_id = args.get("booking_id")
        bags = args.get("bags", 1)

        if not booking_id:
            return {"error": "booking_id is required"}

        booking = self.state["bookings"].get(booking_id)
        if not booking:
            return {"error": f"Booking {booking_id} not found"}

        current_bags = booking["baggage"]["checked_bags"]
        new_total = current_bags + bags

        # Calculate fee
        fee = 0
        for i in range(current_bags, new_total):
            if i == 0:
                fee += self.state["policies"]["baggage_fees"]["first_bag"]
            else:
                fee += self.state["policies"]["baggage_fees"]["second_bag"]

        self.state["bookings"][booking_id]["baggage"]["checked_bags"] = new_total

        return {
            "success": True,
            "booking_id": booking_id,
            "total_checked_bags": new_total,
            "fee_charged": fee,
            "message": f"Added {bags} bag(s). Fee: ${fee:.2f}",
        }

    async def _get_passenger_info(self, args: dict[str, Any]) -> dict[str, Any]:
        """Get passenger information."""
        passenger_id = args.get("passenger_id")
        if not passenger_id:
            return {"error": "passenger_id is required"}

        passenger = self.state["passengers"].get(passenger_id)
        if not passenger:
            return {"error": f"Passenger {passenger_id} not found"}

        return passenger

    async def _upgrade_cabin(self, args: dict[str, Any]) -> dict[str, Any]:
        """Upgrade to a higher cabin class."""
        booking_id = args.get("booking_id")
        flight_id = args.get("flight_id")
        new_cabin = args.get("new_cabin")

        if not booking_id or not new_cabin:
            return {"error": "booking_id and new_cabin are required"}

        booking = self.state["bookings"].get(booking_id)
        if not booking:
            return {"error": f"Booking {booking_id} not found"}

        # Find the flight
        for flight in booking["flights"]:
            if flight["flight_id"] == flight_id or flight_id is None:
                current_cabin = flight["cabin_class"]
                flight_info = self.state["flights"].get(flight["flight_id"])

                if not flight_info:
                    return {"error": "Flight information not available"}

                if new_cabin not in flight_info["available_seats"]:
                    return {"error": f"Cabin class {new_cabin} not available on this flight"}

                if flight_info["available_seats"][new_cabin] <= 0:
                    return {"error": f"No seats available in {new_cabin}"}

                # Calculate upgrade cost
                current_price = flight_info["prices"].get(current_cabin, 0)
                new_price = flight_info["prices"].get(new_cabin, 0)
                upgrade_cost = max(0, new_price - current_price)

                flight["cabin_class"] = new_cabin
                flight["seat"] = "TBD"  # New seat assignment needed

                return {
                    "success": True,
                    "booking_id": booking_id,
                    "flight_id": flight["flight_id"],
                    "new_cabin": new_cabin,
                    "upgrade_cost": upgrade_cost,
                    "message": f"Upgraded to {new_cabin}. Cost: ${upgrade_cost:.2f}",
                }

        return {"error": "Flight not found in booking"}

    async def _request_special_assistance(self, args: dict[str, Any]) -> dict[str, Any]:
        """Request special assistance for a passenger."""
        booking_id = args.get("booking_id")
        assistance_type = args.get("type")
        notes = args.get("notes", "")

        if not booking_id or not assistance_type:
            return {"error": "booking_id and type are required"}

        booking = self.state["bookings"].get(booking_id)
        if not booking:
            return {"error": f"Booking {booking_id} not found"}

        if "special_assistance" not in self.state["bookings"][booking_id]:
            self.state["bookings"][booking_id]["special_assistance"] = []

        self.state["bookings"][booking_id]["special_assistance"].append({
            "type": assistance_type,
            "notes": notes,
            "requested_at": datetime.now().isoformat(),
        })

        return {
            "success": True,
            "booking_id": booking_id,
            "assistance_type": assistance_type,
            "message": f"Special assistance ({assistance_type}) has been noted on your booking.",
        }

    async def _get_boarding_pass(self, args: dict[str, Any]) -> dict[str, Any]:
        """Get boarding pass for a flight."""
        booking_id = args.get("booking_id")
        flight_id = args.get("flight_id")

        if not booking_id:
            return {"error": "booking_id is required"}

        booking = self.state["bookings"].get(booking_id)
        if not booking:
            return {"error": f"Booking {booking_id} not found"}

        # Find the flight
        for flight in booking["flights"]:
            if flight["flight_id"] == flight_id or flight_id is None:
                return {
                    "booking_id": booking_id,
                    "passenger_name": booking["passenger_name"],
                    "flight_number": flight["flight_number"],
                    "origin": flight["origin"],
                    "destination": flight["destination"],
                    "departure": flight["departure"],
                    "seat": flight["seat"],
                    "cabin_class": flight["cabin_class"],
                    "boarding_group": "3",
                    "barcode": f"BP-{booking_id}-{flight['flight_id']}",
                }

        return {"error": "Flight not found in booking"}

    async def _check_in(self, args: dict[str, Any]) -> dict[str, Any]:
        """Check in for a flight."""
        booking_id = args.get("booking_id")
        flight_id = args.get("flight_id")

        if not booking_id:
            return {"error": "booking_id is required"}

        booking = self.state["bookings"].get(booking_id)
        if not booking:
            return {"error": f"Booking {booking_id} not found"}

        for flight in booking["flights"]:
            if flight["flight_id"] == flight_id or flight_id is None:
                departure = datetime.fromisoformat(flight["departure"])
                hours_until = (departure - datetime.now()).total_seconds() / 3600

                if hours_until > 24:
                    return {"error": "Check-in opens 24 hours before departure"}
                if hours_until < 1:
                    return {"error": "Check-in has closed for this flight"}

                flight["status"] = "checked_in"

                return {
                    "success": True,
                    "booking_id": booking_id,
                    "flight_id": flight["flight_id"],
                    "message": "Successfully checked in!",
                    "boarding_pass_url": f"https://airline.example.com/bp/{booking_id}",
                }

        return {"error": "Flight not found in booking"}

    async def _get_policies(self, args: dict[str, Any]) -> dict[str, Any]:
        """Get airline policies."""
        policy_type = args.get("type")

        if policy_type == "cancellation":
            return {
                "free_cancellation_hours": self.state["policies"]["free_cancellation_hours"],
                "cancellation_fees": self.state["policies"]["cancellation_fee"],
            }
        elif policy_type == "change":
            return {
                "change_fees": self.state["policies"]["change_fee"],
                "same_day_change_fee": self.state["policies"]["same_day_change_fee"],
            }
        elif policy_type == "baggage":
            return {"baggage_fees": self.state["policies"]["baggage_fees"]}
        else:
            return self.state["policies"]

    async def _calculate_change_fee(self, args: dict[str, Any]) -> dict[str, Any]:
        """Calculate the fee for changing a flight."""
        booking_id = args.get("booking_id")
        new_flight_id = args.get("new_flight_id")

        if not booking_id or not new_flight_id:
            return {"error": "booking_id and new_flight_id are required"}

        booking = self.state["bookings"].get(booking_id)
        if not booking:
            return {"error": f"Booking {booking_id} not found"}

        new_flight = self.state["flights"].get(new_flight_id)
        if not new_flight:
            return {"error": f"Flight {new_flight_id} not found"}

        old_flight = booking["flights"][0]
        cabin = old_flight["cabin_class"]

        change_fee = self.state["policies"]["change_fee"].get(cabin, 75.00)
        old_price = self.state["flights"].get(old_flight["flight_id"], {}).get("prices", {}).get(cabin, 0)
        new_price = new_flight["prices"].get(cabin, 0)
        fare_difference = max(0, new_price - old_price)

        return {
            "change_fee": change_fee,
            "fare_difference": fare_difference,
            "total": change_fee + fare_difference,
        }

    async def _list_passenger_bookings(self, args: dict[str, Any]) -> dict[str, Any]:
        """List all bookings for a passenger."""
        passenger_id = args.get("passenger_id")
        if not passenger_id:
            return {"error": "passenger_id is required"}

        bookings = [
            {
                "booking_id": b["booking_id"],
                "status": b["status"],
                "flights": [
                    {
                        "flight_number": f["flight_number"],
                        "origin": f["origin"],
                        "destination": f["destination"],
                        "departure": f["departure"],
                    }
                    for f in b["flights"]
                ],
            }
            for b in self.state["bookings"].values()
            if b["passenger_id"] == passenger_id
        ]

        return {"passenger_id": passenger_id, "bookings": bookings, "count": len(bookings)}

    async def _escalate_to_supervisor(self, args: dict[str, Any]) -> dict[str, Any]:
        """Escalate an issue to a supervisor."""
        reason = args.get("reason", "")

        return {
            "success": True,
            "ticket_id": f"ESC-{datetime.now().strftime('%Y%m%d%H%M%S')}",
            "message": "Issue has been escalated to a supervisor. Expected response within 24 hours.",
            "reason": reason,
        }

    async def check_policy_compliance(self) -> list[str]:
        """Check for policy violations in the tool call history."""
        violations = []

        for call in self.tool_call_history:
            # Check upgrade timing policy
            if call.tool_name == "upgrade_cabin":
                booking_id = call.arguments.get("booking_id")
                booking = self.state["bookings"].get(booking_id)
                if booking:
                    first_flight = booking["flights"][0]
                    departure = datetime.fromisoformat(first_flight["departure"])
                    hours_until = (departure - datetime.now()).total_seconds() / 3600
                    if hours_until < self.state["policies"]["upgrade_available_hours"]:
                        violations.append(
                            f"Upgrade requested within {self.state['policies']['upgrade_available_hours']} hours of departure"
                        )

            # Check refund authorization for high-value bookings
            if call.tool_name == "cancel_booking":
                booking_id = call.arguments.get("booking_id")
                booking = self.state["bookings"].get(booking_id)
                if booking and booking.get("total_price", 0) > 1000:
                    has_escalation = any(
                        c.tool_name == "escalate_to_supervisor"
                        for c in self.tool_call_history
                    )
                    if not has_escalation:
                        violations.append("High-value booking (>$1000) cancelled without supervisor approval")

        return violations

    async def check_goal_achieved(self) -> bool:
        """Check if the task goal has been achieved."""
        success_criteria = self.task.success_criteria

        for criterion in success_criteria:
            if criterion == "booking_cancelled":
                cancelled = any(
                    b["status"] == "cancelled"
                    for b in self.state["bookings"].values()
                )
                if not cancelled:
                    return False

            elif criterion == "flight_changed":
                if not self.state["changes"]:
                    return False

            elif criterion == "flights_searched":
                searched = any(
                    c.tool_name == "search_flights" for c in self.tool_call_history
                )
                if not searched:
                    return False

            elif criterion == "change_fee_calculated":
                calculated = any(
                    c.tool_name == "calculate_change_fee" for c in self.tool_call_history
                )
                if not calculated:
                    return False

            elif criterion == "seat_selected":
                # Check if any booking has a non-TBD seat
                has_seat = any(
                    any(f["seat"] != "TBD" for f in b["flights"])
                    for b in self.state["bookings"].values()
                )
                if not has_seat:
                    return False

            elif criterion == "checked_in":
                checked_in = any(
                    any(f["status"] == "checked_in" for f in b["flights"])
                    for b in self.state["bookings"].values()
                )
                if not checked_in:
                    return False

        return True

    @classmethod
    def default_tools(cls) -> list[ToolDefinition]:
        """Get the default tool set for the airline domain."""
        return [
            ToolDefinition(
                name="search_flights",
                description="Search for available flights between two airports",
                parameters={
                    "type": "object",
                    "properties": {
                        "origin": {"type": "string", "description": "Origin airport code (e.g., JFK)"},
                        "destination": {"type": "string", "description": "Destination airport code (e.g., LAX)"},
                        "date": {"type": "string", "description": "Travel date (YYYY-MM-DD)"},
                        "cabin_class": {"type": "string", "description": "Cabin class (economy, business, first)"},
                    },
                    "required": ["origin", "destination"],
                },
            ),
            ToolDefinition(
                name="get_booking_details",
                description="Get complete details of a flight booking",
                parameters={
                    "type": "object",
                    "properties": {
                        "booking_id": {"type": "string", "description": "The booking confirmation number"}
                    },
                    "required": ["booking_id"],
                },
            ),
            ToolDefinition(
                name="get_flight_status",
                description="Get current status of a flight (on-time, delayed, cancelled)",
                parameters={
                    "type": "object",
                    "properties": {
                        "flight_id": {"type": "string", "description": "Flight ID"},
                        "flight_number": {"type": "string", "description": "Flight number (e.g., AA100)"},
                    },
                },
            ),
            ToolDefinition(
                name="cancel_booking",
                description="Cancel a flight booking",
                parameters={
                    "type": "object",
                    "properties": {
                        "booking_id": {"type": "string", "description": "The booking to cancel"},
                        "reason": {"type": "string", "description": "Reason for cancellation"},
                    },
                    "required": ["booking_id"],
                },
            ),
            ToolDefinition(
                name="change_flight",
                description="Change to a different flight",
                parameters={
                    "type": "object",
                    "properties": {
                        "booking_id": {"type": "string", "description": "The booking to modify"},
                        "old_flight_id": {"type": "string", "description": "Current flight ID"},
                        "new_flight_id": {"type": "string", "description": "New flight ID"},
                    },
                    "required": ["booking_id", "new_flight_id"],
                },
            ),
            ToolDefinition(
                name="select_seat",
                description="Select or change a seat assignment",
                parameters={
                    "type": "object",
                    "properties": {
                        "booking_id": {"type": "string", "description": "The booking"},
                        "flight_id": {"type": "string", "description": "The flight"},
                        "seat": {"type": "string", "description": "Seat number (e.g., 24A)"},
                    },
                    "required": ["booking_id", "flight_id", "seat"],
                },
            ),
            ToolDefinition(
                name="get_seat_map",
                description="Get available seats for a flight",
                parameters={
                    "type": "object",
                    "properties": {
                        "flight_id": {"type": "string", "description": "The flight ID"}
                    },
                    "required": ["flight_id"],
                },
            ),
            ToolDefinition(
                name="add_baggage",
                description="Add checked baggage to a booking",
                parameters={
                    "type": "object",
                    "properties": {
                        "booking_id": {"type": "string", "description": "The booking"},
                        "bags": {"type": "integer", "description": "Number of bags to add"},
                    },
                    "required": ["booking_id"],
                },
            ),
            ToolDefinition(
                name="get_passenger_info",
                description="Get passenger account information",
                parameters={
                    "type": "object",
                    "properties": {
                        "passenger_id": {"type": "string", "description": "Passenger ID"}
                    },
                    "required": ["passenger_id"],
                },
            ),
            ToolDefinition(
                name="upgrade_cabin",
                description="Upgrade to a higher cabin class",
                parameters={
                    "type": "object",
                    "properties": {
                        "booking_id": {"type": "string", "description": "The booking"},
                        "flight_id": {"type": "string", "description": "The flight (optional)"},
                        "new_cabin": {"type": "string", "description": "Target cabin class"},
                    },
                    "required": ["booking_id", "new_cabin"],
                },
            ),
            ToolDefinition(
                name="request_special_assistance",
                description="Request special assistance (wheelchair, hearing, etc.)",
                parameters={
                    "type": "object",
                    "properties": {
                        "booking_id": {"type": "string", "description": "The booking"},
                        "type": {"type": "string", "description": "Type of assistance needed"},
                        "notes": {"type": "string", "description": "Additional notes"},
                    },
                    "required": ["booking_id", "type"],
                },
            ),
            ToolDefinition(
                name="get_boarding_pass",
                description="Get boarding pass for a flight",
                parameters={
                    "type": "object",
                    "properties": {
                        "booking_id": {"type": "string", "description": "The booking"},
                        "flight_id": {"type": "string", "description": "The flight (optional)"},
                    },
                    "required": ["booking_id"],
                },
            ),
            ToolDefinition(
                name="check_in",
                description="Check in for a flight (available 24 hours before departure)",
                parameters={
                    "type": "object",
                    "properties": {
                        "booking_id": {"type": "string", "description": "The booking"},
                        "flight_id": {"type": "string", "description": "The flight (optional)"},
                    },
                    "required": ["booking_id"],
                },
            ),
            ToolDefinition(
                name="get_policies",
                description="Get airline policies (cancellation, change, baggage)",
                parameters={
                    "type": "object",
                    "properties": {
                        "type": {"type": "string", "description": "Policy type (cancellation, change, baggage)"}
                    },
                },
            ),
            ToolDefinition(
                name="calculate_change_fee",
                description="Calculate the fee for changing to a different flight",
                parameters={
                    "type": "object",
                    "properties": {
                        "booking_id": {"type": "string", "description": "The booking"},
                        "new_flight_id": {"type": "string", "description": "Target flight ID"},
                    },
                    "required": ["booking_id", "new_flight_id"],
                },
            ),
            ToolDefinition(
                name="list_passenger_bookings",
                description="List all bookings for a passenger",
                parameters={
                    "type": "object",
                    "properties": {
                        "passenger_id": {"type": "string", "description": "Passenger ID"}
                    },
                    "required": ["passenger_id"],
                },
            ),
            ToolDefinition(
                name="escalate_to_supervisor",
                description="Escalate an issue to a supervisor",
                parameters={
                    "type": "object",
                    "properties": {
                        "reason": {"type": "string", "description": "Reason for escalation"},
                        "booking_id": {"type": "string", "description": "Related booking ID"},
                    },
                    "required": ["reason"],
                },
            ),
        ]

    def get_available_tools(self) -> list[ToolDefinition]:
        """Get list of available tools for airline domain."""
        return self.default_tools()

    def get_policy_constraints(self) -> list[PolicyConstraint]:
        """Get policy constraints for airline domain."""
        return [
            PolicyConstraint(
                policy_id="FREE_CANCEL",
                description="Free cancellation within 24 hours of booking",
                check_function="check_free_cancellation",
                severity="info",
                domain=TauDomain.AIRLINE,
            ),
            PolicyConstraint(
                policy_id="CHANGE_FEE",
                description="Change fees apply based on cabin class",
                check_function="check_change_fee",
                severity="warning",
                domain=TauDomain.AIRLINE,
            ),
            PolicyConstraint(
                policy_id="UPGRADE_TIMING",
                description="Upgrades must be requested at least 72 hours before departure",
                check_function="check_upgrade_timing",
                severity="error",
                domain=TauDomain.AIRLINE,
            ),
            PolicyConstraint(
                policy_id="HIGH_VALUE_AUTH",
                description="Cancellations over $1000 require supervisor approval",
                check_function="check_high_value_auth",
                severity="error",
                domain=TauDomain.AIRLINE,
            ),
        ]
