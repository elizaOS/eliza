#!/usr/bin/python3 -I
#
# vim: tabstop=8 expandtab shiftwidth=4 softtabstop=4

import functools
import os
import re

from distutils.version import StrictVersion
from sh import git as _real_git


class Git:
    """
    Provide facilities to inspect the content of a Tails Git repository.

    Note that some methods are memoized, so an instance of this class
    is not guaranteed to produce up-to-date results if the Git repository
    is modified externally during the lifetime of the object.
    """

    # These branches must always exist. They will never be automatically deleted.
    STATIC_BRANCHES = [
        "devel",
        "master",
        "stable",
        "testing",
    ]

    def __init__(self, git_repo):
        self.git_repo = git_repo
        assert os.access(self.git_repo, os.R_OK)
        assert os.path.isdir(self.git_repo)
        self.git_args = "--git-dir=%s" % self.git_repo
        assert self.is_bare_repo(), "Please use a git bare repository."

    def is_bare_repo(self):
        if self.git("rev-parse", "--is-bare-repository").splitlines() == ["false"]:
            return False
        return True

    def all_branches(self):
        return [
            self.clean_branch_name(branch)
            for branch in self.git("--no-pager", "branch", "--no-color").splitlines()
        ]

    def new_revs_in_branch(self, oldrev, branch):
        return self.git("rev-list", "%s..%s" % (oldrev, branch)).splitlines()

    def revs_in_branch_after(self, since, branch):
        return self.git("rev-list", "--since=%s" % since, "%s" % branch).splitlines()

    def tags(self):
        return self.git("tag").splitlines()

    @functools.lru_cache()
    def release_tags(self):
        return [
            tag for tag in self.tags() if not re.search(r"-(?:alpha|beta|rc)\d*$", tag)
        ]

    @functools.lru_cache()
    def last_release_tag(self):
        return "%s" % max([StrictVersion(tag) for tag in self.release_tags()])

    @functools.lru_cache(maxsize=None)
    def clean_branch_name(self, branch):
        """Clean the branch name."""
        return re.fullmatch(r"[*]?\s*(.+)", branch).group(1)

    def has_commits_since_last_release(self, branch):
        last_release_tag = self.last_release_tag()
        revs_on_top_of_last_release = self.new_revs_in_branch(last_release_tag, branch)
        date_of_last_release = self.committer_date(last_release_tag)
        for commit in revs_on_top_of_last_release:
            if self.committer_date(commit) > date_of_last_release:
                return True
        return False

    def has_commits_since(self, since, branch):
        return self.revs_in_branch_after(since, branch)

    @functools.lru_cache(maxsize=None)
    def committer_date(self, commit):
        return self.git(
            "--no-pager", "show", "-1", "--no-patch", '--pretty=format:"%ct"', commit
        ).__str__()

    def branches_merged_into(self, commit):
        return [
            self.clean_branch_name(branch)
            for branch in self.git(
                "--no-pager", "branch", "--no-color", "--no-column", "--merged", commit
            ).splitlines()
        ]

    def branches_to_delete(self):
        return [
            branch
            for branch in self.branches_merged_into("master")
            if not branch in Git.STATIC_BRANCHES
        ]

    def push(self, remote, refs):
        self.git("push", remote, *refs)

    def git(self, *args):
        return _real_git(self.git_args, args)
