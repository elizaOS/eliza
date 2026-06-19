/*
 * Copyright (C) 2004-2009 Kay Sievers <kay.sievers@vrfy.org>
 *
 * + Trimmed from udev-149. Fixed passing of devtype parameter.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 1
#ifndef _BSD_SOURCE
#define _BSD_SOURCE
#endif
#endif

#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <stddef.h>
#include <string.h>
#include <fcntl.h>
#include <errno.h>
#include <signal.h>
#include <getopt.h>
#include <sys/time.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/select.h>
#include <linux/types.h>
#include <linux/netlink.h>
#include <libudev.h>

static volatile sig_atomic_t udev_exit;

static void sig_handler(int signum)
{
	if (signum == SIGINT || signum == SIGTERM)
		udev_exit = 2;
}

static int print_device(struct udev_device *device, const char *f_action, const char *f_devsuffix)
{
	struct timeval  tv;

    const  char *action  = udev_device_get_action(device);
    const  char *devpath = udev_device_get_devpath(device);
    size_t f_len, d_len;

	gettimeofday(&tv, NULL);
	printf("%lu.%06u %s %s\n",
	       (unsigned long) tv.tv_sec, (unsigned int) tv.tv_usec,
	       action, devpath);

    if (! strcmp(f_action, action)) {
        f_len = strlen(f_devsuffix);
        d_len = strlen(devpath);

        if (d_len >= f_len && !strcmp(devpath+(d_len-f_len), f_devsuffix))
            return 1;
    }

    return 0;
}

int main(int argc, char *argv[])
{
	int rc = 0;

	struct udev *udev;

	struct sigaction act;
	sigset_t mask;
	struct udev_monitor *kernel_monitor = NULL;
	fd_set readfds;

	const char *filter_subsys    = "block";
	/* const char *filter_devtype   = "partition"; */
	const char *filter_devsuffix;
	const char *filter_devtype;
	const char *filter_action;

	udev = udev_new();
	if (udev == NULL)
		goto out2;

	if (argc != 3)
		goto out2;

	filter_devsuffix = argv[1];
	filter_devtype = argv[2];

	if (strcmp(filter_devtype, "cd") == 0) {
		filter_action = "change";
	} else if (strcmp(filter_devtype, "disk") == 0) {
		filter_action = "remove";
	}

	/* set signal handlers */
	memset(&act, 0x00, sizeof(struct sigaction));
	act.sa_handler = sig_handler;
	sigemptyset(&act.sa_mask);
	act.sa_flags = SA_RESTART;
	sigaction(SIGINT, &act, NULL);
	sigaction(SIGTERM, &act, NULL);
	sigemptyset(&mask);
	sigaddset(&mask, SIGINT);
	sigaddset(&mask, SIGTERM);
	sigprocmask(SIG_UNBLOCK, &mask, NULL);

	kernel_monitor = udev_monitor_new_from_netlink(udev, "kernel");
	if (kernel_monitor == NULL) {
		fprintf(stderr, "error: unable to create netlink socket\n");
		rc = 3;
		goto out;
	}

	if (udev_monitor_filter_add_match_subsystem_devtype(kernel_monitor, filter_subsys, NULL /* filter_devtype */) < 0)
		fprintf(stderr, "error: unable to apply subsystem filter '%s:%s'\n", filter_subsys, "NULL" /* filter_devtype */);

	if (udev_monitor_enable_receiving(kernel_monitor) < 0) {
		fprintf(stderr, "error: unable to subscribe to kernel events\n");
		rc = 4;
		goto out;
	}

	while (!udev_exit) {
		int fdcount;

		FD_ZERO(&readfds);
		if (kernel_monitor != NULL)
			FD_SET(udev_monitor_get_fd(kernel_monitor), &readfds);

		fdcount = select(udev_monitor_get_fd(kernel_monitor)+1,
				 &readfds, NULL, NULL, NULL);
		if (fdcount < 0) {
			if (errno != EINTR)
				fprintf(stderr, "error receiving uevent message: %s\n", strerror(errno));
			continue;
		}

		if ((kernel_monitor != NULL) && FD_ISSET(udev_monitor_get_fd(kernel_monitor), &readfds)) {
			struct udev_device *device;

			device = udev_monitor_receive_device(kernel_monitor);
			if (device == NULL)
				continue;
			if (print_device(device, filter_action, filter_devsuffix))
                udev_exit = 1;

			udev_device_unref(device);
		}
	}

out:
	udev_monitor_unref(kernel_monitor);

out2:
	udev_unref(udev);

    if (udev_exit == 2)
        rc = 1;

	return rc;
}
