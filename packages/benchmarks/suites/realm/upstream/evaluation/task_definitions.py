"""
Task Definitions for REALM-Bench

This module defines the 11 real-world planning and scheduling tasks with their
specific constraints, goals, and evaluation criteria.
"""

from typing import Dict, List, Any, Optional
from dataclasses import dataclass, field
from enum import Enum


class TaskCategory(Enum):
    """Categories of planning tasks"""
    SCHEDULING = "scheduling"
    ROUTING = "routing"
    LOGISTICS = "logistics"
    DISASTER_RELIEF = "disaster_relief"
    SUPPLY_CHAIN = "supply_chain"


class DisruptionType(Enum):
    """Types of disruptions that can occur"""
    MACHINE_BREAKDOWN = "machine_breakdown"
    TRAFFIC_DELAY = "traffic_delay"
    ROAD_CLOSURE = "road_closure"
    FLIGHT_DELAY = "flight_delay"
    RESOURCE_SHORTAGE = "resource_shortage"
    WEATHER_EVENT = "weather_event"


@dataclass
class TaskConstraint:
    """Definition of a task constraint"""
    constraint_id: str
    constraint_type: str  # deadline, dependency, resource, capacity
    description: str
    parameters: Dict[str, Any]
    weight: float = 1.0


@dataclass
class TaskGoal:
    """Definition of a task goal"""
    goal_id: str
    description: str
    weight: float = 1.0
    success_criteria: Dict[str, Any] = field(default_factory=dict)


@dataclass
class TaskDefinition:
    """Complete definition of a planning task"""
    task_id: str
    name: str
    category: TaskCategory
    description: str
    goals: List[TaskGoal]
    constraints: List[TaskConstraint]
    resources: Dict[str, Any]
    optimal_solution: Optional[Dict[str, Any]] = None
    disruption_scenarios: List[Dict[str, Any]] = field(default_factory=list)
    evaluation_weights: Dict[str, float] = field(default_factory=dict)


@dataclass
class TaskResult:
    """Result of executing a task"""
    task_id: str
    framework: str
    execution_time: float
    achieved_goals: List[str]
    satisfied_constraints: List[str]
    resource_usage: Dict[str, Any]
    schedule: List[Dict[str, Any]]
    disruptions_handled: List[Dict[str, Any]]
    replanning_attempts: List[Dict[str, Any]]
    metrics: Dict[str, float]


# Task Definitions for the 11 scenarios

TASK_DEFINITIONS = {
    "P11": TaskDefinition(
        task_id="P11",
        name="Job Shop Scheduling (JSSP)",
        category=TaskCategory.SCHEDULING,
        description="Canonical combinatorial optimization task for sequencing jobs on machines",
        goals=[
            TaskGoal("minimize_makespan", "Minimize total completion time", 0.4),
            TaskGoal("minimize_idle_time", "Minimize machine idle time", 0.3),
            TaskGoal("balance_workload", "Balance workload across machines", 0.3)
        ],
        constraints=[
            TaskConstraint("job_precedence", "dependency", "Jobs must follow precedence constraints", 
                          {"job_sequence": ["job1", "job2", "job3"]}),
            TaskConstraint("machine_capacity", "capacity", "Each machine can process one job at a time", 
                          {"capacity": 1}),
            TaskConstraint("deadline", "deadline", "All jobs must complete by deadline", 
                          {"deadline": 100})
        ],
        resources={
            "machines": 3,
            "jobs": 5,
            "processing_times": [[2, 3, 1], [4, 2, 3], [1, 4, 2], [3, 1, 4], [2, 3, 1]]
        },
        disruption_scenarios=[
            {"type": DisruptionType.MACHINE_BREAKDOWN, "machine_id": 1, "duration": 10},
            {"type": DisruptionType.RESOURCE_SHORTAGE, "resource": "material", "shortage": 0.5}
        ],
        evaluation_weights={
            "planning_quality": 0.3,
            "planning_optimality": 0.4,
            "coordination_effectiveness": 0.1,
            "constraint_satisfaction": 0.2
        }
    ),

    "P1": TaskDefinition(
        task_id="P1",
        name="Single-Agent Campus Tour",
        category=TaskCategory.ROUTING,
        description="Planning visit waypoints within time windows under spatial constraints",
        goals=[
            TaskGoal("visit_all_locations", "Visit all required campus locations", 0.5),
            TaskGoal("minimize_travel_time", "Minimize total travel time", 0.3),
            TaskGoal("respect_time_windows", "Respect all time window constraints", 0.2)
        ],
        constraints=[
            TaskConstraint("time_windows", "deadline", "Each location has specific time windows", 
                          {"windows": {"library": [9, 12], "cafeteria": [11, 14], "gym": [15, 18]}}),
            TaskConstraint("travel_time", "resource", "Travel time between locations", 
                          {"distances": {"library-cafeteria": 10, "cafeteria-gym": 15}}),
            TaskConstraint("tour_duration", "deadline", "Total tour must complete within time limit", 
                          {"max_duration": 180})
        ],
        resources={
            "locations": ["library", "cafeteria", "gym", "student_center"],
            "start_location": "entrance",
            "end_location": "entrance"
        },
        evaluation_weights={
            "planning_quality": 0.4,
            "planning_optimality": 0.3,
            "constraint_satisfaction": 0.3
        }
    ),

    "P2": TaskDefinition(
        task_id="P2",
        name="Multi-Group Campus Tours",
        category=TaskCategory.SCHEDULING,
        description="Scheduling multiple tour guides to serve independent visitor groups concurrently",
        goals=[
            TaskGoal("serve_all_groups", "Serve all visitor groups", 0.4),
            TaskGoal("minimize_wait_time", "Minimize group wait times", 0.3),
            TaskGoal("balance_guide_workload", "Balance workload across guides", 0.3)
        ],
        constraints=[
            TaskConstraint("guide_availability", "resource", "Guide availability schedules", 
                          {"guides": {"guide1": [9, 17], "guide2": [10, 16]}}),
            TaskConstraint("group_size", "capacity", "Maximum group size per guide", 
                          {"max_group_size": 15}),
            TaskConstraint("tour_duration", "deadline", "Each tour must complete within time limit", 
                          {"tour_duration": 90})
        ],
        resources={
            "guides": ["guide1", "guide2", "guide3"],
            "groups": [{"id": "group1", "size": 12, "preferred_time": 10}, 
                      {"id": "group2", "size": 8, "preferred_time": 11}]
        },
        evaluation_weights={
            "planning_quality": 0.3,
            "planning_optimality": 0.3,
            "coordination_effectiveness": 0.4
        }
    ),

    "P3": TaskDefinition(
        task_id="P3",
        name="Urban Ride-Sharing (URS)",
        category=TaskCategory.ROUTING,
        description="Planning and scheduling to optimize ride assignments for passengers with deadlines and vehicle constraints",
        goals=[
            TaskGoal("serve_all_passengers", "Serve all passenger requests", 0.4),
            TaskGoal("minimize_total_distance", "Minimize total vehicle travel distance", 0.3),
            TaskGoal("meet_deadlines", "Meet all passenger deadlines", 0.3)
        ],
        constraints=[
            TaskConstraint("vehicle_capacity", "capacity", "Vehicle passenger capacity", 
                          {"capacities": {"vehicle1": 4, "vehicle2": 6}}),
            TaskConstraint("passenger_deadlines", "deadline", "Passenger arrival deadlines", 
                          {"deadlines": {"passenger1": 30, "passenger2": 45}}),
            TaskConstraint("vehicle_fuel", "resource", "Vehicle fuel constraints", 
                          {"fuel_limits": {"vehicle1": 100, "vehicle2": 150}})
        ],
        resources={
            "vehicles": [{"id": "vehicle1", "location": "downtown", "capacity": 4, "fuel": 100},
                        {"id": "vehicle2", "location": "airport", "capacity": 6, "fuel": 150}],
            "passengers": [{"id": "passenger1", "pickup": "downtown", "dropoff": "airport", "deadline": 30},
                          {"id": "passenger2", "pickup": "suburb", "dropoff": "downtown", "deadline": 45}]
        },
        evaluation_weights={
            "planning_quality": 0.3,
            "planning_optimality": 0.4,
            "coordination_effectiveness": 0.3
        }
    ),

    "P4": TaskDefinition(
        task_id="P4",
        name="URS with Disruptions",
        category=TaskCategory.ROUTING,
        description="Planning and scheduling with traffic delays and dynamic changes to route feasibility",
        goals=[
            TaskGoal("serve_all_passengers", "Serve all passenger requests", 0.3),
            TaskGoal("minimize_delays", "Minimize delays due to disruptions", 0.4),
            TaskGoal("adapt_to_changes", "Successfully adapt to route changes", 0.3)
        ],
        constraints=[
            TaskConstraint("vehicle_capacity", "capacity", "Vehicle passenger capacity", 
                          {"capacities": {"vehicle1": 4, "vehicle2": 6}}),
            TaskConstraint("passenger_deadlines", "deadline", "Passenger arrival deadlines", 
                          {"deadlines": {"passenger1": 30, "passenger2": 45}}),
            TaskConstraint("route_availability", "resource", "Route availability constraints", 
                          {"blocked_routes": ["downtown-airport"]})
        ],
        resources={
            "vehicles": [{"id": "vehicle1", "location": "downtown", "capacity": 4},
                        {"id": "vehicle2", "location": "airport", "capacity": 6}],
            "passengers": [{"id": "passenger1", "pickup": "downtown", "dropoff": "airport", "deadline": 30}]
        },
        disruption_scenarios=[
            {"type": DisruptionType.TRAFFIC_DELAY, "route": "downtown-airport", "delay": 15},
            {"type": DisruptionType.ROAD_CLOSURE, "route": "suburb-downtown", "duration": 30}
        ],
        evaluation_weights={
            "planning_quality": 0.2,
            "planning_optimality": 0.3,
            "coordination_effectiveness": 0.2,
            "adaptation": 0.3
        }
    ),

    "P5": TaskDefinition(
        task_id="P5",
        name="Wedding Logistics",
        category=TaskCategory.LOGISTICS,
        description="Planning and scheduling to coordinate group arrivals, errands, and shared vehicle usage under deadlines",
        goals=[
            TaskGoal("coordinate_arrivals", "Coordinate all guest arrivals", 0.3),
            TaskGoal("complete_errands", "Complete all required errands", 0.3),
            TaskGoal("optimize_vehicle_usage", "Optimize shared vehicle usage", 0.4)
        ],
        constraints=[
            TaskConstraint("wedding_deadline", "deadline", "Wedding ceremony deadline", 
                          {"deadline": "18:00"}),
            TaskConstraint("vehicle_capacity", "capacity", "Vehicle passenger capacity", 
                          {"capacities": {"van": 8, "car1": 4, "car2": 4}}),
            TaskConstraint("errand_dependencies", "dependency", "Errand completion dependencies", 
                          {"dependencies": [["flowers", "decorations"], ["cake", "reception"]]})
        ],
        resources={
            "vehicles": [{"id": "van", "capacity": 8, "location": "hotel"},
                        {"id": "car1", "capacity": 4, "location": "church"},
                        {"id": "car2", "capacity": 4, "location": "reception_venue"}],
            "errands": ["flowers", "cake", "decorations", "photographer", "music"],
            "guests": [{"id": "family1", "arrival_time": "14:00", "location": "airport"},
                      {"id": "family2", "arrival_time": "15:00", "location": "hotel"}]
        },
        evaluation_weights={
            "planning_quality": 0.3,
            "planning_optimality": 0.3,
            "coordination_effectiveness": 0.4
        }
    ),

    "P6": TaskDefinition(
        task_id="P6",
        name="Thanksgiving Dinner Planning",
        category=TaskCategory.LOGISTICS,
        description="Planning and scheduling to synchronize travel and meal preparation among family members with airport pickups and kitchen dependencies",
        goals=[
            TaskGoal("coordinate_travel", "Coordinate all family travel", 0.3),
            TaskGoal("prepare_meal", "Complete meal preparation on time", 0.4),
            TaskGoal("minimize_conflicts", "Minimize kitchen and resource conflicts", 0.3)
        ],
        constraints=[
            TaskConstraint("dinner_deadline", "deadline", "Dinner serving deadline", 
                          {"deadline": "18:00"}),
            TaskConstraint("kitchen_capacity", "capacity", "Kitchen workspace capacity", 
                          {"max_cooks": 3}),
            TaskConstraint("cooking_dependencies", "dependency", "Cooking task dependencies", 
                          {"dependencies": [["turkey", "gravy"], ["potatoes", "mashed_potatoes"]]}),
            TaskConstraint("airport_pickups", "resource", "Airport pickup scheduling", 
                          {"pickup_times": {"flight1": "14:00", "flight2": "15:30"}})
        ],
        resources={
            "vehicles": [{"id": "car1", "capacity": 4, "location": "home"},
                        {"id": "car2", "capacity": 4, "location": "airport"}],
            "cooking_tasks": ["turkey", "stuffing", "gravy", "potatoes", "vegetables", "dessert"],
            "family_members": [{"id": "mom", "skills": ["turkey", "gravy"], "arrival": "home"},
                              {"id": "dad", "skills": ["potatoes"], "arrival": "airport"}]
        },
        evaluation_weights={
            "planning_quality": 0.3,
            "planning_optimality": 0.3,
            "coordination_effectiveness": 0.4
        }
    ),

    "P7": TaskDefinition(
        task_id="P7",
        name="Disaster Relief Deployment",
        category=TaskCategory.DISASTER_RELIEF,
        description="Planning and scheduling to allocate aid and personnel across regions under uncertainty and evolving needs",
        goals=[
            TaskGoal("maximize_aid_delivery", "Maximize aid delivery to affected areas", 0.4),
            TaskGoal("minimize_response_time", "Minimize response time to emergencies", 0.3),
            TaskGoal("optimize_resource_allocation", "Optimize resource allocation", 0.3)
        ],
        constraints=[
            TaskConstraint("resource_availability", "resource", "Available relief resources", 
                          {"resources": {"medical_supplies": 1000, "food": 5000, "water": 2000}}),
            TaskConstraint("personnel_capacity", "capacity", "Personnel availability", 
                          {"personnel": {"doctors": 20, "nurses": 50, "logistics": 30}}),
            TaskConstraint("emergency_deadlines", "deadline", "Emergency response deadlines", 
                          {"deadlines": {"critical": 2, "urgent": 6, "normal": 24}})
        ],
        resources={
            "regions": [{"id": "region1", "severity": "critical", "needs": ["medical", "food"]},
                       {"id": "region2", "severity": "urgent", "needs": ["water", "shelter"]}],
            "personnel": [{"id": "team1", "skills": ["medical"], "location": "base"},
                         {"id": "team2", "skills": ["logistics"], "location": "base"}],
            "vehicles": [{"id": "helicopter1", "capacity": 1000, "speed": "fast"},
                        {"id": "truck1", "capacity": 5000, "speed": "slow"}]
        },
        disruption_scenarios=[
            {"type": DisruptionType.WEATHER_EVENT, "region": "region1", "impact": "transport_blocked"},
            {"type": DisruptionType.RESOURCE_SHORTAGE, "resource": "medical_supplies", "shortage": 0.3}
        ],
        evaluation_weights={
            "planning_quality": 0.3,
            "planning_optimality": 0.3,
            "coordination_effectiveness": 0.2,
            "adaptation": 0.2
        }
    ),

    "P8": TaskDefinition(
        task_id="P8",
        name="Wedding Logistics with Disruptions",
        category=TaskCategory.LOGISTICS,
        description="Planning and scheduling with road closures and timing conflicts requiring reactive replanning",
        goals=[
            TaskGoal("coordinate_arrivals", "Coordinate all guest arrivals", 0.3),
            TaskGoal("complete_errands", "Complete all required errands", 0.3),
            TaskGoal("adapt_to_disruptions", "Successfully adapt to disruptions", 0.4)
        ],
        constraints=[
            TaskConstraint("wedding_deadline", "deadline", "Wedding ceremony deadline", 
                          {"deadline": "18:00"}),
            TaskConstraint("vehicle_capacity", "capacity", "Vehicle passenger capacity", 
                          {"capacities": {"van": 8, "car1": 4, "car2": 4}}),
            TaskConstraint("route_availability", "resource", "Route availability constraints", 
                          {"blocked_routes": ["hotel-church", "church-reception"]})
        ],
        resources={
            "vehicles": [{"id": "van", "capacity": 8, "location": "hotel"},
                        {"id": "car1", "capacity": 4, "location": "church"}],
            "errands": ["flowers", "cake", "decorations", "photographer"],
            "guests": [{"id": "family1", "arrival_time": "14:00", "location": "airport"}]
        },
        disruption_scenarios=[
            {"type": DisruptionType.ROAD_CLOSURE, "route": "hotel-church", "duration": 60},
            {"type": DisruptionType.TRAFFIC_DELAY, "route": "airport-hotel", "delay": 30}
        ],
        evaluation_weights={
            "planning_quality": 0.2,
            "planning_optimality": 0.2,
            "coordination_effectiveness": 0.3,
            "adaptation": 0.3
        }
    ),

    "P9": TaskDefinition(
        task_id="P9",
        name="Thanksgiving Dinner with Disruptions",
        category=TaskCategory.LOGISTICS,
        description="Planning and scheduling with flight delays and recovery windows for meal and guest coordination",
        goals=[
            TaskGoal("coordinate_travel", "Coordinate all family travel", 0.3),
            TaskGoal("prepare_meal", "Complete meal preparation on time", 0.3),
            TaskGoal("adapt_to_delays", "Successfully adapt to flight delays", 0.4)
        ],
        constraints=[
            TaskConstraint("dinner_deadline", "deadline", "Dinner serving deadline", 
                          {"deadline": "18:00"}),
            TaskConstraint("kitchen_capacity", "capacity", "Kitchen workspace capacity", 
                          {"max_cooks": 3}),
            TaskConstraint("flight_schedules", "resource", "Flight arrival schedules", 
                          {"flights": {"flight1": "14:00", "flight2": "15:30"}})
        ],
        resources={
            "vehicles": [{"id": "car1", "capacity": 4, "location": "home"},
                        {"id": "car2", "capacity": 4, "location": "airport"}],
            "cooking_tasks": ["turkey", "stuffing", "gravy", "potatoes"],
            "family_members": [{"id": "mom", "skills": ["turkey"], "flight": "flight1"},
                              {"id": "dad", "skills": ["potatoes"], "flight": "flight2"}]
        },
        disruption_scenarios=[
            {"type": DisruptionType.FLIGHT_DELAY, "flight": "flight1", "delay": 90},
            {"type": DisruptionType.FLIGHT_DELAY, "flight": "flight2", "delay": 60}
        ],
        evaluation_weights={
            "planning_quality": 0.2,
            "planning_optimality": 0.2,
            "coordination_effectiveness": 0.3,
            "adaptation": 0.3
        }
    ),

    "P10": TaskDefinition(
        task_id="P10",
        name="Global GPU Supply Chain",
        category=TaskCategory.SUPPLY_CHAIN,
        description="Large-scale industrial project planning with procurement, infrastructure dependencies, and cost-risk tradeoffs",
        goals=[
            TaskGoal("minimize_total_cost", "Minimize total project cost", 0.3),
            TaskGoal("meet_delivery_deadlines", "Meet all delivery deadlines", 0.3),
            TaskGoal("optimize_inventory", "Optimize inventory levels", 0.2),
            TaskGoal("minimize_risk", "Minimize supply chain risks", 0.2)
        ],
        constraints=[
            TaskConstraint("budget_limit", "resource", "Total project budget", 
                          {"budget": 1000000}),
            TaskConstraint("delivery_deadlines", "deadline", "Component delivery deadlines", 
                          {"deadlines": {"gpu_chips": 30, "memory": 45, "cooling": 60}}),
            TaskConstraint("supplier_capacity", "capacity", "Supplier production capacity", 
                          {"capacities": {"supplier1": 1000, "supplier2": 800}}),
            TaskConstraint("infrastructure_dependencies", "dependency", "Infrastructure dependencies", 
                          {"dependencies": [["power_supply", "assembly"], ["testing", "packaging"]]})
        ],
        resources={
            "suppliers": [{"id": "supplier1", "location": "asia", "capacity": 1000, "lead_time": 30},
                         {"id": "supplier2", "location": "europe", "capacity": 800, "lead_time": 45}],
            "components": ["gpu_chips", "memory", "cooling", "power_supply", "pcb"],
            "facilities": [{"id": "assembly", "capacity": 500, "location": "usa"},
                          {"id": "testing", "capacity": 300, "location": "usa"}]
        },
        disruption_scenarios=[
            {"type": DisruptionType.RESOURCE_SHORTAGE, "component": "gpu_chips", "shortage": 0.4},
            {"type": DisruptionType.MACHINE_BREAKDOWN, "facility": "assembly", "duration": 7}
        ],
        evaluation_weights={
            "planning_quality": 0.3,
            "planning_optimality": 0.4,
            "coordination_effectiveness": 0.2,
            "adaptation": 0.1
        }
    )
} 