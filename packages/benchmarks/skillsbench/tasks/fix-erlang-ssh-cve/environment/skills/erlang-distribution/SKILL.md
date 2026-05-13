---
name: erlang-distribution
description: Use when erlang distributed systems including node connectivity, distributed processes, global name registration, distributed supervision, network partitions, and building fault-tolerant multi-node applications on the BEAM VM.
---

# Erlang Distribution

## Introduction

Erlang's built-in distribution enables building clustered, fault-tolerant systems
across multiple nodes. Processes on different nodes communicate transparently
through the same message-passing primitives used locally. This location transparency
makes distributed programming natural and straightforward.

The distribution layer handles network communication, serialization, and node
connectivity automatically. Nodes discover each other through naming, with processes
addressable globally via registered names or pid references. Understanding distribution
patterns is essential for building scalable, resilient systems.

This skill covers node connectivity and clustering, distributed message passing,
global name registration, distributed supervision, handling network partitions,
RPC patterns, and building production distributed applications.

## Node Connectivity

Nodes connect to form clusters for distributed computation and fault tolerance.

```erlang
%% Starting named nodes
%% erl -name node1@hostname -setcookie secret
%% erl -sname node2 -setcookie secret

%% Connecting nodes
connect_nodes() ->
    Node1 = 'node1@host',
    Node2 = 'node2@host',
    net_kernel:connect_node(Node2).

%% Check connected nodes
list_nodes() ->
    Nodes = [node() | nodes()],
    io:format("Connected nodes: ~p~n", [Nodes]).

%% Monitor node connections
monitor_nodes() ->
    net_kernel:monitor_nodes(true),
    receive
        {nodeup, Node} ->
            io:format("Node up: ~p~n", [Node]);
        {nodedown, Node} ->
            io:format("Node down: ~p~n", [Node])
    end.

%% Node configuration
start_distributed() ->
    {ok, _} = net_kernel:start([mynode, shortnames]),
    erlang:set_cookie(node(), secret_cookie).

%% Hidden nodes (for monitoring)
connect_hidden(Node) ->
    net_kernel:connect_node(Node),
    erlang:disconnect_node(Node),
    net_kernel:hidden_connect_node(Node).

%% Get node information
node_info() ->
    #{
        name => node(),
        cookie => erlang:get_cookie(),
        nodes => nodes(),
        alive => is_alive()
    }.
```

Node connectivity enables building distributed clusters with automatic discovery.

## Distributed Message Passing

Send messages to processes on remote nodes using same syntax as local messaging.

```erlang
%% Send to registered process on remote node
send_remote(Node, Name, Message) ->
    {Name, Node} ! Message.

%% Spawn process on remote node
spawn_on_remote(Node, Fun) ->
    spawn(Node, Fun).

spawn_on_remote(Node, Module, Function, Args) ->
    spawn(Node, Module, Function, Args).

%% Distributed request-response
remote_call(Node, Module, Function, Args) ->
    Pid = spawn(Node, fun() ->
        Result = apply(Module, Function, Args),
        receive
            {From, Ref} -> From ! {Ref, Result}
        end
    end),
    Ref = make_ref(),
    Pid ! {self(), Ref},
    receive
        {Ref, Result} -> {ok, Result}
    after 5000 ->
        {error, timeout}
    end.

%% Distributed work distribution
-module(work_dispatcher).
-export([start/0, dispatch/1]).

start() ->
    register(?MODULE, spawn(fun() -> loop([]) end)).

dispatch(Work) ->
    ?MODULE ! {dispatch, Work}.

loop(Workers) ->
    receive
        {dispatch, Work} ->
            Node = select_node(nodes()),
            Pid = spawn(Node, fun() -> do_work(Work) end),
            loop([{Pid, Node} | Workers])
    end.

select_node(Nodes) ->
    lists:nth(rand:uniform(length(Nodes)), Nodes).

do_work(Work) ->
    Result = process_work(Work),
    io:format("Work done on ~p: ~p~n", [node(), Result]).

process_work(Work) -> Work * 2.

%% Remote group leader for output
remote_process_with_io(Node) ->
    spawn(Node, fun() ->
        group_leader(self(), self()),
        io:format("Output from ~p~n", [node()])
    end).
```

Location-transparent messaging enables seamless distributed communication.

## Global Name Registration

Register process names globally across distributed clusters.

```erlang
%% Global registration
register_global(Name) ->
    Pid = spawn(fun() -> global_loop() end),
    global:register_name(Name, Pid),
    Pid.

global_loop() ->
    receive
        {From, Message} ->
            From ! {reply, Message},
            global_loop();
        stop -> ok
    end.

%% Send to globally registered process
send_global(Name, Message) ->
    case global:whereis_name(Name) of
        undefined ->
            {error, not_found};
        Pid ->
            Pid ! Message,
            ok
    end.

%% Global name with conflict resolution
register_with_resolve(Name) ->
    Pid = spawn(fun() -> server_loop() end),
    ResolveFun = fun(Name, Pid1, Pid2) ->
        %% Keep process on node with lower name
        case node(Pid1) < node(Pid2) of
            true -> Pid1;
            false -> Pid2
        end
    end,
    global:register_name(Name, Pid, ResolveFun).

server_loop() ->
    receive
        Message ->
            io:format("Received: ~p on ~p~n", [Message, node()]),
            server_loop()
    end.

%% Global synchronization
sync_global() ->
    global:sync().

%% List globally registered names
list_global_names() ->
    global:registered_names().

%% Re-register after node reconnection
ensure_global_registration(Name, Fun) ->
    case global:whereis_name(Name) of
        undefined ->
            Pid = spawn(Fun),
            global:register_name(Name, Pid),
            Pid;
        Pid ->
            Pid
    end.
```

Global registration enables location-independent process discovery.

## Distributed Supervision

Supervise processes across multiple nodes for cluster-wide fault tolerance.

```erlang
-module(distributed_supervisor).
-behaviour(supervisor).

-export([start_link/0, start_worker/1]).
-export([init/1]).

start_link() ->
    supervisor:start_link({local, ?MODULE}, ?MODULE, []).

start_worker(Node) ->
    ChildSpec = #{
        id => make_ref(),
        start => {worker, start_link, [Node]},
        restart => permanent,
        type => worker
    },
    supervisor:start_child(?MODULE, ChildSpec).

init([]) ->
    SupFlags = #{
        strategy => one_for_one,
        intensity => 5,
        period => 60
    },
    {ok, {SupFlags, []}}.

%% Worker module spawning on specific node
-module(worker).
-export([start_link/1, loop/0]).

start_link(Node) ->
    Pid = spawn_link(Node, ?MODULE, loop, []),
    {ok, Pid}.

loop() ->
    receive
        stop -> ok;
        Msg ->
            io:format("Worker on ~p: ~p~n", [node(), Msg]),
            loop()
    end.

%% Distributed process groups
-module(pg_example).
-export([start/0, join/1, broadcast/1]).

start() ->
    pg:start_link().

join(Group) ->
    pg:join(Group, self()).

broadcast(Group, Message) ->
    Members = pg:get_members(Group),
    [Pid ! Message || Pid <- Members].
```

Distributed supervision maintains system health across node failures.

## RPC and Remote Execution

Execute function calls on remote nodes with various invocation patterns.

```erlang
%% Basic RPC
simple_rpc(Node, Module, Function, Args) ->
    rpc:call(Node, Module, Function, Args).

%% RPC with timeout
timed_rpc(Node, Module, Function, Args, Timeout) ->
    rpc:call(Node, Module, Function, Args, Timeout).

%% Async RPC
async_rpc(Node, Module, Function, Args) ->
    Key = rpc:async_call(Node, Module, Function, Args),
    %% Later retrieve result
    rpc:yield(Key).

%% Parallel RPC to multiple nodes
parallel_rpc(Nodes, Module, Function, Args) ->
    rpc:multicall(Nodes, Module, Function, Args).

%% Parallel call with results
parallel_rpc_results(Nodes, Module, Function, Args) ->
    rpc:multicall(Nodes, Module, Function, Args, 5000).

%% Cast (fire and forget)
cast_rpc(Node, Module, Function, Args) ->
    rpc:cast(Node, Module, Function, Args).

%% Broadcast to all nodes
broadcast_rpc(Module, Function, Args) ->
    Nodes = [node() | nodes()],
    rpc:multicall(Nodes, Module, Function, Args).

%% Parallel map over nodes
pmap_nodes(Fun, List) ->
    Nodes = nodes(),
    DistFun = fun(X) ->
        Node = lists:nth((X rem length(Nodes)) + 1, Nodes),
        rpc:call(Node, erlang, apply, [Fun, [X]])
    end,
    lists:map(DistFun, List).
```

RPC enables convenient remote execution with location transparency.

## Network Partitions and CAP

Handle network partitions and understand CAP theorem trade-offs.

```erlang
%% Detect network partition
detect_partition() ->
    ExpectedNodes = [node1@host, node2@host, node3@host],
    CurrentNodes = nodes(),
    Missing = ExpectedNodes -- CurrentNodes,
    case Missing of
        [] -> ok;
        Nodes -> {partition, Nodes}
    end.

%% Partition healing strategy
-module(partition_handler).
-export([monitor_cluster/1]).

monitor_cluster(ExpectedNodes) ->
    net_kernel:monitor_nodes(true),
    monitor_loop(ExpectedNodes, nodes()).

monitor_loop(Expected, Current) ->
    receive
        {nodeup, Node} ->
            NewCurrent = [Node | Current],
            case length(NewCurrent) == length(Expected) of
                true ->
                    io:format("Cluster fully connected~n"),
                    heal_partition();
                false ->
                    ok
            end,
            monitor_loop(Expected, NewCurrent);

        {nodedown, Node} ->
            NewCurrent = lists:delete(Node, Current),
            io:format("Partition detected: ~p~n", [Node]),
            monitor_loop(Expected, NewCurrent)
    end.

heal_partition() ->
    %% Synchronize state after partition heals
    global:sync(),
    ok.

%% Consensus with majority
-module(consensus).
-export([propose/2, vote/3]).

propose(Nodes, Value) ->
    Ref = make_ref(),
    [Node ! {vote, self(), Ref, Value} || Node <- Nodes],
    collect_votes(Ref, length(Nodes), 0).

collect_votes(_Ref, Total, Votes) when Votes > Total div 2 ->
    {ok, majority};
collect_votes(_Ref, Total, Total) ->
    {error, no_majority};
collect_votes(Ref, Total, Votes) ->
    receive
        {vote, Ref, accept} ->
            collect_votes(Ref, Total, Votes + 1);
        {vote, Ref, reject} ->
            collect_votes(Ref, Total, Votes)
    after 5000 ->
        {error, timeout}
    end.

vote(From, Ref, Value) ->
    Decision = evaluate_proposal(Value),
    From ! {vote, Ref, Decision}.

evaluate_proposal(_Value) -> accept.
```

Partition handling strategies maintain system availability during network failures.

## Best Practices

1. **Use short names for local clusters** and long names for internet-wide distribution

2. **Set same cookie** on all nodes in trusted cluster for security

3. **Monitor node connections** to detect and handle network partitions

4. **Use global registration sparingly** as it adds coordination overhead

5. **Implement partition detection** and healing strategies for resilience

6. **Design for eventual consistency** in distributed systems accepting CAP limitations

7. **Use RPC for simple calls** but prefer message passing for complex protocols

8. **Test with network failures** using tools like toxiproxy or chaos engineering

9. **Implement proper timeouts** on distributed calls to handle slow networks

10. **Use distributed supervision** to maintain fault tolerance across nodes

## Common Pitfalls

1. **Not setting cookies** prevents nodes from connecting causing silent failures

2. **Using global registry everywhere** creates single point of failure and bottleneck

3. **Not handling node disconnection** causes processes to hang indefinitely

4. **Assuming network reliability** leads to incorrect behavior during partitions

5. **Using long timeouts** in RPC calls causes cascading delays during failures

6. **Not testing network partitions** misses critical failure modes

7. **Forgetting to synchronize** global registry after partition heals

8. **Using same node name** on multiple machines causes conflicts

9. **Not monitoring node health** prevents detecting degraded cluster state

10. **Relying on strict consistency** in distributed setting violates CAP theorem

## When to Use This Skill

Apply distribution when building systems requiring high availability and fault tolerance.

Use distributed supervision for critical services needing automatic failover.

Leverage multiple nodes for horizontal scalability beyond single machine limits.

Implement distributed systems when geographic distribution provides latency benefits.

Use clustering for load distribution across multiple servers.

Apply distribution patterns for building resilient microservices architectures.

## Resources

- [Erlang Distribution Protocol](<https://www.erlang.org/doc/apps/erts/erl_dist_protocol.html>)
- [Distributed Erlang](<https://www.erlang.org/doc/reference_manual/distributed.html>)
- [Learn You Some Erlang - Distributed OTP](<https://learnyousomeerlang.com/distributed-otp-applications>)
- [Designing Distributed Systems](<https://www.oreilly.com/library/view/designing-distributed-systems/9781491983638/>)
- [CAP Theorem Explained](<https://www.infoq.com/articles/cap-twelve-years-later-how-the-rules-have-changed/>)
