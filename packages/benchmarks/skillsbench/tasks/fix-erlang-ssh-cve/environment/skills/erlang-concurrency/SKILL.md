---
name: erlang-concurrency
description: Use when erlang's concurrency model including lightweight processes, message passing, process links and monitors, error handling patterns, selective receive, and building massively concurrent systems on the BEAM VM.
---

# Erlang Concurrency

## Introduction

Erlang's concurrency model based on lightweight processes and message passing
enables building massively scalable systems. Processes are isolated with no shared
memory, communicating asynchronously through messages. This model eliminates
concurrency bugs common in shared-memory systems.

The BEAM VM efficiently schedules millions of processes, each with its own heap
and mailbox. Process creation is fast and cheap, enabling "process per entity"
designs. Links and monitors provide failure detection, while selective receive
enables flexible message handling patterns.

This skill covers process creation and spawning, message passing patterns,
process links and monitors, selective receive, error propagation, concurrent
design patterns, and building scalable concurrent systems.

## Process Creation and Spawning

Create lightweight processes for concurrent task execution.

```erlang
%% Basic process spawning
simple_spawn() ->
    Pid = spawn(fun() ->
        io:format("Hello from process ~p~n", [self()])
    end),
    Pid.

%% Spawn with arguments
spawn_with_args(Message) ->
    spawn(fun() ->
        io:format("Message: ~p~n", [Message])
    end).

%% Spawn and register
spawn_registered() ->
    Pid = spawn(fun() -> loop() end),
    register(my_process, Pid),
    Pid.

loop() ->
    receive
        stop -> ok;
        Msg ->
            io:format("Received: ~p~n", [Msg]),
            loop()
    end.

%% Spawn link (linked processes)
spawn_linked() ->
    spawn_link(fun() ->
        timer:sleep(1000),
        io:format("Linked process done~n")
    end).

%% Spawn monitor
spawn_monitored() ->
    {Pid, Ref} = spawn_monitor(fun() ->
        timer:sleep(500),
        exit(normal)
    end),
    {Pid, Ref}.

%% Process pools
create_pool(N) ->
    [spawn(fun() -> worker_loop() end) || _ <- lists:seq(1, N)].

worker_loop() ->
    receive
        {work, Data, From} ->
            Result = process_data(Data),
            From ! {result, Result},
            worker_loop();
        stop ->
            ok
    end.

process_data(Data) -> Data * 2.

%% Parallel map
pmap(F, List) ->
    Parent = self(),
    Pids = [spawn(fun() ->
        Parent ! {self(), F(X)}
    end) || X <- List],
    [receive {Pid, Result} -> Result end || Pid <- Pids].


%% Fork-join pattern
fork_join(Tasks) ->
    Self = self(),
    Pids = [spawn(fun() ->
        Result = Task(),
        Self ! {self(), Result}
    end) || Task <- Tasks],
    [receive {Pid, Result} -> Result end || Pid <- Pids].
```

Lightweight processes enable massive concurrency with minimal overhead.

## Message Passing Patterns

Processes communicate through asynchronous message passing without shared memory.

```erlang
%% Send and receive
send_message() ->
    Pid = spawn(fun() ->
        receive
            {From, Msg} ->
                io:format("Received: ~p~n", [Msg]),
                From ! {reply, "Acknowledged"}
        end
    end),
    Pid ! {self(), "Hello"},
    receive
        {reply, Response} ->
            io:format("Response: ~p~n", [Response])
    after 5000 ->
        io:format("Timeout~n")
    end.

%% Request-response pattern
request(Pid, Request) ->
    Ref = make_ref(),
    Pid ! {self(), Ref, Request},
    receive
        {Ref, Response} -> {ok, Response}
    after 5000 ->
        {error, timeout}
    end.

server_loop() ->
    receive
        {From, Ref, {add, A, B}} ->
            From ! {Ref, A + B},
            server_loop();
        {From, Ref, {multiply, A, B}} ->
            From ! {Ref, A * B},
            server_loop();
        stop -> ok
    end.

%% Publish-subscribe
start_pubsub() ->
    spawn(fun() -> pubsub_loop([]) end).

pubsub_loop(Subscribers) ->
    receive
        {subscribe, Pid} ->
            pubsub_loop([Pid | Subscribers]);
        {unsubscribe, Pid} ->
            pubsub_loop(lists:delete(Pid, Subscribers));
        {publish, Message} ->
            [Pid ! {message, Message} || Pid <- Subscribers],
            pubsub_loop(Subscribers)
    end.

%% Pipeline pattern
pipeline(Data, Functions) ->
    lists:foldl(fun(F, Acc) -> F(Acc) end, Data, Functions).

concurrent_pipeline(Data, Stages) ->
    Self = self(),
    lists:foldl(fun(Stage, AccData) ->
        Pid = spawn(fun() ->
            Result = Stage(AccData),
            Self ! {result, Result}
        end),
        receive {result, R} -> R end
    end, Data, Stages).
```

Message passing enables safe concurrent communication without locks.

## Links and Monitors

Links bidirectionally connect processes while monitors provide one-way observation.

```erlang
%% Process linking
link_example() ->
    process_flag(trap_exit, true),
    Pid = spawn_link(fun() ->
        timer:sleep(1000),
        exit(normal)
    end),
    receive
        {'EXIT', Pid, Reason} ->
            io:format("Process exited: ~p~n", [Reason])
    end.

%% Monitoring
monitor_example() ->
    Pid = spawn(fun() ->
        timer:sleep(500),
        exit(normal)
    end),
    Ref = monitor(process, Pid),
    receive
        {'DOWN', Ref, process, Pid, Reason} ->
            io:format("Process down: ~p~n", [Reason])
    end.

%% Supervisor pattern
supervisor() ->
    process_flag(trap_exit, true),
    Worker = spawn_link(fun() -> worker() end),
    supervisor_loop(Worker).

supervisor_loop(Worker) ->
    receive
        {'EXIT', Worker, _Reason} ->
            NewWorker = spawn_link(fun() -> worker() end),
            supervisor_loop(NewWorker)
    end.

worker() ->
    receive
        crash -> exit(crashed);
        work -> worker()
    end.
```

Links and monitors enable building fault-tolerant systems with automatic
failure detection.

## Best Practices

1. **Create processes liberally** as they are lightweight and cheap to spawn

2. **Use message passing exclusively** for inter-process communication
   without shared state

3. **Implement proper timeouts** on receives to prevent indefinite blocking

4. **Use monitors for one-way observation** when bidirectional linking unnecessary

5. **Keep process state minimal** to reduce memory usage per process

6. **Use registered names sparingly** as global names limit scalability

7. **Implement proper error handling** with links and monitors for fault tolerance

8. **Use selective receive** to handle specific messages while leaving others queued

9. **Avoid message accumulation** by handling all message patterns in receive clauses

10. **Profile concurrent systems** to identify bottlenecks and optimize hot paths

## Common Pitfalls

1. **Creating too few processes** underutilizes Erlang's concurrency model

2. **Not using timeouts** in receive causes indefinite blocking on failure

3. **Accumulating messages** in mailboxes causes memory leaks and performance degradation

4. **Using shared ETS tables** as mutex replacement defeats isolation benefits

5. **Not handling all message types** causes mailbox overflow with unmatched messages

6. **Forgetting to trap exits** in supervisors prevents proper error handling

7. **Creating circular links** causes cascading failures without proper supervision

8. **Using processes for fine-grained parallelism** adds overhead without benefits

9. **Not monitoring spawned processes** loses track of failures

10. **Overusing registered names** creates single points of failure and contention

## When to Use This Skill

Apply processes for concurrent tasks requiring isolation and independent state.

Use message passing for all inter-process communication in distributed systems.

Leverage links and monitors to build fault-tolerant supervision hierarchies.

Create process pools for concurrent request handling and parallel computation.

Use selective receive for complex message handling protocols.

## Resources

- [Erlang Concurrency Tutorial](<https://www.erlang.org/doc/getting_started/conc_prog.html>)
- [Learn You Some Erlang - Concurrency](<https://learnyousomeerlang.com/the-hitchhikers-guide-to-concurrency>)
- [Erlang Process Manual](<https://www.erlang.org/doc/reference_manual/processes.html>)
- [Designing for Scalability with Erlang/OTP](<https://www.oreilly.com/library/view/designing-for-scalability/9781449361556/>)
- [Programming Erlang](<https://pragprog.com/titles/jaerlang2/programming-erlang-2nd-edition/>)
