---
name: erlang-otp-behaviors
description: Use when oTP behaviors including gen_server for stateful processes, gen_statem for state machines, supervisors for fault tolerance, gen_event for event handling, and building robust, production-ready Erlang applications with proven patterns.
---

# Erlang OTP Behaviors

## Introduction

OTP (Open Telecom Platform) behaviors provide reusable patterns for common process
types in Erlang systems. These abstractions handle complex details like message
passing, error handling, and state management, allowing developers to focus on
business logic while maintaining system reliability.

Behaviors define interfaces that processes must implement, with OTP handling the
infrastructure. Gen_server provides client-server processes, gen_statem implements
state machines, supervisors manage process lifecycles, and gen_event coordinates
event distribution. Understanding these patterns is essential for production Erlang.

This skill covers gen_server for stateful processes, gen_statem for complex state
machines, supervisor trees for fault tolerance, gen_event for event handling,
application behavior for packaging, and patterns for building robust OTP systems.

## Gen_Server Basics

Gen_server implements client-server processes with synchronous and asynchronous
communication.

```erlang
-module(counter_server).
-behaviour(gen_server).

%% API
-export([start_link/0, increment/0, decrement/0, get_value/0, reset/0]).

%% gen_server callbacks
-export([init/1, handle_call/3, handle_cast/2, handle_info/2, terminate/2, code_change/3]).

-define(SERVER, ?MODULE).

%% State record
-record(state, {count = 0}).

%%%===================================================================
%%% API
%%%===================================================================

start_link() ->
    gen_server:start_link({local, ?SERVER}, ?MODULE, [], []).

increment() ->
    gen_server:cast(?SERVER, increment).

decrement() ->
    gen_server:cast(?SERVER, decrement).

get_value() ->
    gen_server:call(?SERVER, get_value).

reset() ->
    gen_server:call(?SERVER, reset).

%%%===================================================================
%%% gen_server callbacks
%%%===================================================================

init([]) ->
    {ok, #state{}}.

%% Synchronous calls (with response)
handle_call(get_value, _From, State) ->
    {reply, State#state.count, State};

handle_call(reset, _From, State) ->
    {reply, ok, State#state{count = 0}};

handle_call(_Request, _From, State) ->
    {reply, ignored, State}.

%% Asynchronous casts (no response)
handle_cast(increment, State) ->
    NewCount = State#state.count + 1,
    {noreply, State#state{count = NewCount}};

handle_cast(decrement, State) ->
    NewCount = State#state.count - 1,
    {noreply, State#state{count = NewCount}};

handle_cast(_Msg, State) ->
    {noreply, State}.

%% Handle other messages
handle_info(_Info, State) ->
    {noreply, State}.

terminate(_Reason, _State) ->
    ok.

code_change(_OldVsn, State, _Extra) ->
    {ok, State}.

%%%===================================================================
%%% Complex gen_server example: Cache
%%%===================================================================

-module(cache_server).
-behaviour(gen_server).

-export([start_link/1, put/2, get/1, delete/1, clear/0, size/0]).
-export([init/1, handle_call/3, handle_cast/2, handle_info/2, terminate/2, code_change/3]).

-record(state, {
    cache = #{},
    max_size = 1000,
    hits = 0,
    misses = 0
}).

start_link(MaxSize) ->
    gen_server:start_link({local, ?MODULE}, ?MODULE, [MaxSize], []).

put(Key, Value) ->
    gen_server:call(?MODULE, {put, Key, Value}).

get(Key) ->
    gen_server:call(?MODULE, {get, Key}).

delete(Key) ->
    gen_server:cast(?MODULE, {delete, Key}).

clear() ->
    gen_server:cast(?MODULE, clear).

size() ->
    gen_server:call(?MODULE, size).

init([MaxSize]) ->
    process_flag(trap_exit, true),
    {ok, #state{max_size = MaxSize}}.

handle_call({put, Key, Value}, _From, State) ->
    Cache = State#state.cache,
    case maps:size(Cache) >= State#state.max_size of
        true ->
            {reply, {error, cache_full}, State};
        false ->
            NewCache = maps:put(Key, Value, Cache),
            {reply, ok, State#state{cache = NewCache}}
    end;

handle_call({get, Key}, _From, State) ->
    Cache = State#state.cache,
    case maps:find(Key, Cache) of
        {ok, Value} ->
            NewState = State#state{hits = State#state.hits + 1},
            {reply, {ok, Value}, NewState};
        error ->
            NewState = State#state{misses = State#state.misses + 1},
            {reply, not_found, NewState}
    end;

handle_call(size, _From, State) ->
    Size = maps:size(State#state.cache),
    {reply, Size, State};

handle_call(_Request, _From, State) ->
    {reply, {error, unknown_request}, State}.

handle_cast({delete, Key}, State) ->
    NewCache = maps:remove(Key, State#state.cache),
    {noreply, State#state{cache = NewCache}};

handle_cast(clear, State) ->
    {noreply, State#state{cache = #{}}};

handle_cast(_Msg, State) ->
    {noreply, State}.

handle_info(_Info, State) ->
    {noreply, State}.

terminate(Reason, State) ->
    io:format("Cache terminating: ~p~n", [Reason]),
    io:format("Stats - Hits: ~p, Misses: ~p~n", [State#state.hits, State#state.misses]),
    ok.

code_change(_OldVsn, State, _Extra) ->
    {ok, State}.

%%%===================================================================
%%% gen_server with timeouts
%%%===================================================================

-module(session_server).
-behaviour(gen_server).

-export([start_link/0, touch/0]).
-export([init/1, handle_call/3, handle_cast/2, handle_info/2, terminate/2, code_change/3]).

-define(TIMEOUT, 30000). % 30 seconds

-record(state, {
    last_activity,
    data = #{}
}).

start_link() ->
    gen_server:start_link({local, ?MODULE}, ?MODULE, [], []).

touch() ->
    gen_server:cast(?MODULE, touch).

init([]) ->
    {ok, #state{last_activity = erlang:system_time(millisecond)}, ?TIMEOUT}.

handle_call(_Request, _From, State) ->
    {reply, ok, State, ?TIMEOUT}.

handle_cast(touch, State) ->
    NewState = State#state{last_activity = erlang:system_time(millisecond)},
    {noreply, NewState, ?TIMEOUT};

handle_cast(_Msg, State) ->
    {noreply, State, ?TIMEOUT}.

handle_info(timeout, State) ->
    io:format("Session timed out~n"),
    {stop, normal, State};

handle_info(_Info, State) ->
    {noreply, State, ?TIMEOUT}.

terminate(_Reason, _State) ->
    ok.

code_change(_OldVsn, State, _Extra) ->
    {ok, State}.
```

Gen_server provides structure for stateful processes with client-server patterns.

## Gen_Statem for State Machines

Gen_statem implements finite state machines with explicit state transitions.

```erlang
-module(door_fsm).
-behaviour(gen_statem).

-export([start_link/0, open/0, close/0, lock/0, unlock/1]).
-export([init/1, callback_mode/0, terminate/3, code_change/4]).
-export([locked/3, unlocked/3, open/3]).

-define(CODE, "1234").

start_link() ->
    gen_statem:start_link({local, ?MODULE}, ?MODULE, [], []).

open() ->
    gen_statem:call(?MODULE, open).

close() ->
    gen_statem:call(?MODULE, close).

lock() ->
    gen_statem:call(?MODULE, lock).

unlock(Code) ->
    gen_statem:call(?MODULE, {unlock, Code}).

init([]) ->
    {ok, locked, #{}}.

callback_mode() ->
    state_functions.

%% Locked state
locked(call, {unlock, Code}, Data) when Code =:= ?CODE ->
    {next_state, unlocked, Data, [{reply, ok}]};

locked(call, {unlock, _WrongCode}, Data) ->
    {keep_state, Data, [{reply, {error, wrong_code}}]};

locked(call, _Event, Data) ->
    {keep_state, Data, [{reply, {error, door_locked}}]}.

%% Unlocked state
unlocked(call, lock, Data) ->
    {next_state, locked, Data, [{reply, ok}]};

unlocked(call, open, Data) ->
    {next_state, open, Data, [{reply, ok}]};

unlocked(call, _Event, Data) ->
    {keep_state, Data, [{reply, ok}]}.

%% Open state
open(call, close, Data) ->
    {next_state, unlocked, Data, [{reply, ok}]};

open(call, _Event, Data) ->
    {keep_state, Data, [{reply, {error, door_open}}]}.

terminate(_Reason, _State, _Data) ->
    ok.

code_change(_OldVsn, State, Data, _Extra) ->
    {ok, State, Data}.

%%%===================================================================
%%% Connection state machine
%%%===================================================================

-module(connection_fsm).
-behaviour(gen_statem).

-export([start_link/0, connect/0, disconnect/0, send/1]).
-export([init/1, callback_mode/0, terminate/3, code_change/4]).
-export([disconnected/3, connecting/3, connected/3]).

-record(data, {
    socket = undefined,
    buffer = <<>>,
    retry_count = 0
}).

start_link() ->
    gen_statem:start_link({local, ?MODULE}, ?MODULE, [], []).

connect() ->
    gen_statem:call(?MODULE, connect).

disconnect() ->
    gen_statem:call(?MODULE, disconnect).

send(Data) ->
    gen_statem:call(?MODULE, {send, Data}).

init([]) ->
    {ok, disconnected, #data{}}.

callback_mode() ->
    [state_functions, state_enter].

%% Disconnected state
disconnected(enter, _OldState, _Data) ->
    io:format("Entered disconnected state~n"),
    keep_state_and_data;

disconnected(call, connect, Data) ->
    case connect_to_server() of
        {ok, Socket} ->
            {next_state, connected, Data#data{socket = Socket, retry_count = 0},
             [{reply, ok}]};
        error ->
            NewData = Data#data{retry_count = Data#data.retry_count + 1},
            case NewData#data.retry_count < 3 of
                true ->
                    {next_state, connecting, NewData, [{reply, {error, retrying}}]};
                false ->
                    {keep_state, NewData, [{reply, {error, max_retries}}]}
            end
    end.

%% Connecting state
connecting(enter, _OldState, _Data) ->
    erlang:send_after(1000, self(), retry_connect),
    keep_state_and_data;

connecting(info, retry_connect, Data) ->
    case connect_to_server() of
        {ok, Socket} ->
            {next_state, connected, Data#data{socket = Socket, retry_count = 0}};
        error ->
            NewData = Data#data{retry_count = Data#data.retry_count + 1},
            case NewData#data.retry_count < 3 of
                true ->
                    {keep_state, NewData};
                false ->
                    {next_state, disconnected, NewData}
            end
    end.

%% Connected state
connected(enter, _OldState, _Data) ->
    io:format("Connection established~n"),
    keep_state_and_data;

connected(call, {send, Data}, StateData) ->
    case send_data(StateData#data.socket, Data) of
        ok ->
            {keep_state_and_data, [{reply, ok}]};
        error ->
            {next_state, disconnected, StateData, [{reply, {error, send_failed}}]}
    end;

connected(call, disconnect, StateData) ->
    close_connection(StateData#data.socket),
    {next_state, disconnected, StateData#data{socket = undefined}, [{reply, ok}]}.

terminate(_Reason, _State, Data) ->
    case Data#data.socket of
        undefined -> ok;
        Socket -> close_connection(Socket)
    end.

code_change(_OldVsn, State, Data, _Extra) ->
    {ok, State, Data}.

%% Helper functions
connect_to_server() ->
    {ok, socket}.

send_data(_Socket, _Data) ->
    ok.

close_connection(_Socket) ->
    ok.
```

Gen_statem provides structured state machine implementation with explicit
transitions.

## Supervisor Trees

Supervisors monitor child processes and restart them on failure for fault
tolerance.

```erlang
-module(my_supervisor).
-behaviour(supervisor).

-export([start_link/0]).
-export([init/1]).

start_link() ->
    supervisor:start_link({local, ?MODULE}, ?MODULE, []).

init([]) ->
    SupFlags = #{
        strategy => one_for_one,
        intensity => 5,
        period => 60
    },

    ChildSpecs = [
        #{
            id => counter_server,
            start => {counter_server, start_link, []},
            restart => permanent,
            shutdown => 5000,
            type => worker,
            modules => [counter_server]
        },
        #{
            id => cache_server,
            start => {cache_server, start_link, [1000]},
            restart => permanent,
            shutdown => 5000,
            type => worker,
            modules => [cache_server]
        }
    ],

    {ok, {SupFlags, ChildSpecs}}.

%%%===================================================================
%%% Supervisor strategies
%%%===================================================================

%% one_for_one: Restart only failed child
init_one_for_one([]) ->
    SupFlags = #{strategy => one_for_one},
    Children = [worker_spec(worker1), worker_spec(worker2)],
    {ok, {SupFlags, Children}}.

%% one_for_all: Restart all children if any fails
init_one_for_all([]) ->
    SupFlags = #{strategy => one_for_all},
    Children = [worker_spec(worker1), worker_spec(worker2)],
    {ok, {SupFlags, Children}}.

%% rest_for_one: Restart failed child and all started after it
init_rest_for_one([]) ->
    SupFlags = #{strategy => rest_for_one},
    Children = [
        worker_spec(database),
        worker_spec(cache),  % Depends on database
        worker_spec(api)     % Depends on cache
    ],
    {ok, {SupFlags, Children}}.

worker_spec(Name) ->
    #{
        id => Name,
        start => {Name, start_link, []},
        restart => permanent,
        shutdown => 5000,
        type => worker
    }.

%%%===================================================================
%%% Nested supervisors (supervision tree)
%%%===================================================================

-module(app_supervisor).
-behaviour(supervisor).

-export([start_link/0, init/1]).

start_link() ->
    supervisor:start_link({local, ?MODULE}, ?MODULE, []).

init([]) ->
    SupFlags = #{strategy => one_for_one},

    ChildSpecs = [
        #{
            id => database_sup,
            start => {database_supervisor, start_link, []},
            restart => permanent,
            type => supervisor
        },
        #{
            id => api_sup,
            start => {api_supervisor, start_link, []},
            restart => permanent,
            type => supervisor
        },
        #{
            id => worker_sup,
            start => {worker_supervisor, start_link, []},
            restart => permanent,
            type => supervisor
        }
    ],

    {ok, {SupFlags, ChildSpecs}}.

%%%===================================================================
%%% Dynamic supervision
%%%===================================================================

-module(dynamic_sup).
-behaviour(supervisor).

-export([start_link/0, start_child/1, stop_child/1]).
-export([init/1]).

start_link() ->
    supervisor:start_link({local, ?MODULE}, ?MODULE, []).

start_child(Args) ->
    supervisor:start_child(?MODULE, [Args]).

stop_child(Pid) ->
    supervisor:terminate_child(?MODULE, Pid).

init([]) ->
    SupFlags = #{
        strategy => simple_one_for_one,
        intensity => 5,
        period => 60
    },

    ChildSpec = #{
        id => worker,
        start => {worker, start_link, []},
        restart => temporary,
        shutdown => 5000,
        type => worker
    },

    {ok, {SupFlags, [ChildSpec]}}.
```

Supervisor trees provide automatic fault recovery and system resilience.

## Best Practices

1. **Use gen_server for stateful processes** to leverage OTP infrastructure and
   error handling

2. **Implement all callback functions** even if they return default values for
   completeness

3. **Keep state records simple** to reduce complexity and improve maintainability

4. **Use handle_cast for fire-and-forget** operations without response requirements

5. **Implement proper termination** in terminate/2 for resource cleanup

6. **Set appropriate timeout values** to prevent indefinite blocking in calls

7. **Use gen_statem for complex state machines** with many states and transitions

8. **Design supervisor hierarchies** that match application component dependencies

9. **Use appropriate restart strategies** based on child process relationships

10. **Test supervisor behavior** by intentionally crashing children to verify
    recovery

## Common Pitfalls

1. **Blocking in handle_call** prevents processing other messages causing deadlock

2. **Not matching all message patterns** causes unhandled message accumulation

3. **Forgetting to reply** in handle_call leaves callers waiting indefinitely

4. **Using wrong supervision strategy** causes unnecessary process restarts

5. **Not setting process_flag trap_exit** prevents graceful termination handling

6. **Creating circular dependencies** in supervisor trees causes startup failures

7. **Using temporary restart** for critical processes allows permanent failures

8. **Not implementing code_change** prevents hot code upgrades

9. **Storing large state** in gen_server causes memory issues

10. **Not handling timeout** in state machines allows infinite blocking

## When to Use This Skill

Apply gen_server for any stateful process requiring client-server interaction.

Use gen_statem when implementing protocols or systems with explicit state
transitions.

Leverage supervisors for all applications requiring fault tolerance and automatic
recovery.

Build supervisor trees to structure complex applications with multiple components.

Use OTP behaviors for production systems requiring reliability and maintainability.

## Resources

- [Erlang OTP Design Principles](<https://www.erlang.org/doc/design_principles/users_guide.html>)
- [Gen_server Manual](<https://www.erlang.org/doc/man/gen_server.html>)
- [Gen_statem Manual](<https://www.erlang.org/doc/man/gen_statem.html>)
- [Supervisor Manual](<https://www.erlang.org/doc/man/supervisor.html>)
- [Learn You Some Erlang - OTP](<https://learnyousomeerlang.com/what-is-otp>)
