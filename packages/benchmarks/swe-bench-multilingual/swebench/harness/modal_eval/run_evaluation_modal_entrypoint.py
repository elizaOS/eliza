# Sandbox entrypoint script for running evals on Modal.
#
# In a perfect world, we would execute commands using the Sandbox directly, but Modal imposes
# a container stdio rate limit of 64 KiB/s. Some test harnesses exceed this limit which leads
# to "dropped container output" logs that interfere with parsing the test output. Instead,
# we mount and run this script in the Sandbox to control the rate at which stdio is streamed to
# the container.
import asyncio
import sys
import argparse

# 64 KiB // 2 to be safe
STDIO_RATE_LIMIT_BYTES_PER_SEC = 64 * 1024 // 2


async def exec(command: str) -> int:
    p = await asyncio.create_subprocess_shell(
        command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        limit=1024 * 1024,
    )

    stdout_lines = []
    stderr_lines = []

    async def read_stream(stream, lines, fd):
        tokens = STDIO_RATE_LIMIT_BYTES_PER_SEC
        last_refill = asyncio.get_event_loop().time()

        while True:
            try:
                line = await stream.readline()
                if not line:
                    break
            except (asyncio.LimitOverrunError, ValueError):
                # buffer exceeded asyncio stream limit
                fallback_chunk_size = 8192
                line = await stream.read(fallback_chunk_size)
                if not line:
                    break

            remaining_data = line
            buffer = bytearray()

            while remaining_data:
                current_time = asyncio.get_event_loop().time()
                time_passed = current_time - last_refill

                tokens = min(
                    STDIO_RATE_LIMIT_BYTES_PER_SEC,
                    tokens + (time_passed * STDIO_RATE_LIMIT_BYTES_PER_SEC),
                )
                last_refill = current_time

                chunk_size = min(
                    len(remaining_data), STDIO_RATE_LIMIT_BYTES_PER_SEC, int(tokens)
                )

                if chunk_size == 0:
                    sleep_time = max(
                        0.01,
                        (0.01 * STDIO_RATE_LIMIT_BYTES_PER_SEC - tokens)
                        / STDIO_RATE_LIMIT_BYTES_PER_SEC,
                    )
                    await asyncio.sleep(sleep_time)
                    continue

                buffer.extend(remaining_data[:chunk_size])

                # Find last valid UTF-8 character boundary.
                # This is to avoid partial characters being written to
                # container stdout/stderr, which results in a very small
                # chance of errors of the form: "Error reading stream: 'utf-8' codec can't decode bytes in position ..."
                valid_bytes = len(
                    buffer.decode("utf-8", errors="ignore").encode("utf-8")
                )

                if valid_bytes > 0:
                    chunk = buffer[:valid_bytes]
                    if fd == "stdout":
                        sys.stdout.buffer.write(chunk)
                        sys.stdout.buffer.flush()
                    else:
                        sys.stderr.buffer.write(chunk)
                        sys.stderr.buffer.flush()

                    buffer = buffer[valid_bytes:]
                    tokens -= valid_bytes

                remaining_data = remaining_data[chunk_size:]

            if buffer:
                if fd == "stdout":
                    sys.stdout.buffer.write(buffer)
                    sys.stdout.buffer.flush()
                else:
                    sys.stderr.buffer.write(buffer)
                    sys.stderr.buffer.flush()

            lines.append(line)

    await asyncio.gather(
        read_stream(p.stdout, stdout_lines, "stdout"),
        read_stream(p.stderr, stderr_lines, "stderr"),
    )

    return await p.wait()


async def main(command: str):
    returncode = await exec(command)
    exit(returncode)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Execute a shell command and stream output"
    )
    parser.add_argument("command", type=str, help="The shell command to execute")
    args = parser.parse_args()

    asyncio.run(main(args.command))
