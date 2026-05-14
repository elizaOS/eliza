#!perl

use strictures 2;

use lib qw{lib t/lib};

use Carp;
use Carp::Assert;
use Carp::Assert::More;
use Data::Dumper;
use DateTime;
use English qw{-no_match_vars};
use Function::Parameters;
use Path::Tiny;
use Test::More;
use Test::BDD::Cucumber::StepFile;

use YAML::Any;

use Tails::IUK;
use Tails::IUK::Install;
use Tails::IUK::Utils qw{run_as_root stdout_as_root};

use Test::Util qw{make_iuk};

my $bindir = path(__FILE__)->parent->parent->parent->parent->child('bin')->absolute;
use Env qw{@PATH};
unshift @PATH, $bindir;

Before fun ($c) {
    my $dirname = Path::Tiny->tempdir(CLEANUP => 0);
    $c->{stash}->{scenario}->{tempdir} = $dirname;
    ok(defined($dirname));
};

Given qr{^a (\d+)MB Tails boot device with a blank MBR$}, fun ($c) {
    my $size = $c->matches->[0];
    my $liveos_mountpoint
        = $c->{stash}->{scenario}->{liveos_mountpoint}
        = path($c->{stash}->{scenario}->{tempdir}, 'live', 'medium');
    $liveos_mountpoint->mkpath;

    my $backing_file
        = $c->{stash}->{scenario}->{backing_file}
        = path($c->{stash}->{scenario}->{tempdir}, 'Tails.img');

    my %loop_info = Test::Util::prepare_live_device(
        $backing_file, $liveos_mountpoint, $size
    );
    $c->{stash}->{scenario}->{boot_device}      = $loop_info{boot_device};
    $c->{stash}->{scenario}->{system_partition} = $loop_info{system_partition};
};

Given qr{^a "([^"]+)" IUK that contains (\d+) SquashFS$}, fun ($c) {
    my $iuk_path = $c->{stash}->{scenario}->{tempdir}->child($c->matches->[0]);
    my $wanted_squashfs = $c->matches->[1];

    my @files;
    if ($wanted_squashfs) {
        my ($squashfs_prefix) = ($iuk_path->basename =~ m{\A (.*) [.] iuk}xms);
        @files = map {
            "live/${squashfs_prefix}-$_.squashfs"
        } (1..$wanted_squashfs);
    }
    ok(make_iuk(
        $iuk_path,
        overlay_filenames     => \@files,
        overlay_files_content => 'bla',
    ));
};

Given qr{^a "([^"]+)" IUK whose overlay directory contains (?:the )?(?:(\d+)MB )?file "([^"]+)"$}, fun ($c) {
    my $iuk_path = $c->{stash}->{scenario}->{tempdir}->child($c->matches->[0]);
    my $size = $c->matches->[1];
    my $included_file = $c->matches->[2];

    ok(make_iuk(
        $iuk_path,
        overlay_filenames     => [$included_file],
        defined $size
            ? (overlay_files_size    => $size)
            : (overlay_files_content => 'bla'),
    ));
};

Given qr{^a "([^"]+)" IUK whose overlay directory contains the files (.*) respectively copied from (.*)$}, fun ($c) {
    my $iuk_path = $c->{stash}->{scenario}->{tempdir}->child($c->matches->[0]);
    my $iuk_files_desc = $c->matches->[1];
    my $iuk_source_files_desc = $c->matches->[2];

    $iuk_files_desc =~ s{["]}{}gxms;
    my @iuk_files = split(/ and /, $iuk_files_desc);
    $iuk_source_files_desc =~ s{["]}{}gxms;
    my @iuk_source_files = split(/ and /, $iuk_source_files_desc);
    is(scalar(@iuk_files), scalar(@iuk_source_files));

    my %copied_files;
    for (0..(scalar(@iuk_files) - 1)) {
        $copied_files{$iuk_source_files[$_]} = $iuk_files[$_];
    }

    ok(make_iuk(
        $iuk_path,
        overlay_copied_files => \%copied_files,
    ));
};

Given qr{^a "([^"]+)" IUK whose format version is not supported$}, fun ($c) {
    my $iuk_path = $c->{stash}->{scenario}->{tempdir}->child($c->matches->[0]);
    $c->{stash}->{scenario}->{tempdir}->child('FORMAT')->spew(42);
    make_iuk(
        $iuk_path,
        root_files => [ $c->{stash}->{scenario}->{tempdir}->child('FORMAT') ],
    );
};

Given qr{^a "([^"]+)" IUK whose format version cannot be determined$}, fun ($c) {
    my $iuk_path = $c->{stash}->{scenario}->{tempdir}->child($c->matches->[0]);
    $c->{stash}->{scenario}->{tempdir}->child('FORMAT')->spew('abc');
    make_iuk(
        $iuk_path,
        root_files => [ $c->{stash}->{scenario}->{tempdir}->child('FORMAT') ],
    );
};

Given qr{^a "([^"]+)" IUK that has no FORMAT file$}, fun ($c) {
    my $iuk_path = $c->{stash}->{scenario}->{tempdir}->child($c->matches->[0]);
    $c->{stash}->{scenario}->{tempdir}->child('FORMAT')->spew('abc');
    make_iuk(
        $iuk_path,
        include_format_file => 0,
    );
};

Given qr{^a running Tails that has no IUK installed$}, fun ($c) {
    is(
        scalar(squashfs_in_system_partition(
            $c->{stash}->{scenario}->{liveos_mountpoint}
        )),
        1
    );
};

Given qr{^a "([^"]+)" IUK that deletes files "([^"]*)" in the system partition$}, fun ($c) {
    my $iuk_path = $c->{stash}->{scenario}->{tempdir}->child($c->matches->[0]);

    my @delete_files = split /,[[:blank:]]+/, $c->matches->[1];
    $c->{stash}->{scenario}->{tempdir}->child('control.yml')->spew(
        YAML::Any::Dump({ delete_files => \@delete_files })
    );

    ok(make_iuk(
        $iuk_path,
        root_files => [ $c->{stash}->{scenario}->{tempdir}->child('control.yml') ],
    ));
};

Given qr{^a system partition that contains file "([^"]+)"$}, fun ($c) {
    my $file = path($c->{stash}->{scenario}->{liveos_mountpoint}, $c->matches->[0]);

    Test::Util::remount_for_me_rw(
        $c->{stash}->{scenario}->{system_partition},
        $c->{stash}->{scenario}->{liveos_mountpoint});

    $file->parent->mkpath;
    $file->touch;

    Test::Util::remount_for_root_ro(
        $c->{stash}->{scenario}->{system_partition},
        $c->{stash}->{scenario}->{liveos_mountpoint});

    ok(  Test::Util::has_mount_option(
        $c->{stash}->{scenario}->{liveos_mountpoint}, 'ro'
    ));
    ok(! Test::Util::has_mount_option(
        $c->{stash}->{scenario}->{liveos_mountpoint}, 'rw'
    ));
};

When qr{^I (?:attempt to |)install the "([^"]+)" IUK$}, fun ($c) {
    my $iuk = $c->matches->[0];
    local $@;
    my $cmdline =
        path($bindir, "tails-install-iuk") .
        ' --override_boot_device_file "'       . $c->{stash}->{scenario}->{boot_device}       . '" ' .
        ' --override_system_partition_file "'  . $c->{stash}->{scenario}->{system_partition}  . '" ' .
        ' --override_liveos_mountpoint "'      . $c->{stash}->{scenario}->{liveos_mountpoint} . '" ' .
        '"' . path($c->{stash}->{scenario}->{tempdir}, $iuk) . '"';
    $c->{stash}->{scenario}->{install_output} = `$cmdline 2>&1`;
    $c->{stash}->{scenario}->{install_exit_code} = ${^CHILD_ERROR_NATIVE};
};

Then qr{^it should fail$}, fun ($c) {
    ok(defined $c->{stash}->{scenario}->{install_exit_code})
        and
    isnt($c->{stash}->{scenario}->{install_exit_code}, 0);
};

Then qr{^it should succeed$}, fun ($c) {
    ok(defined $c->{stash}->{scenario}->{install_exit_code});
    is($c->{stash}->{scenario}->{install_exit_code}, 0);

    if (exists $c->{stash}->{scenario}->{install_output}
            && defined $c->{stash}->{scenario}->{install_output}
            && length($c->{stash}->{scenario}->{install_output})) {
        warn $c->{stash}->{scenario}->{install_output};
    }
};

Then qr{^the temporary directory on the system partition should be empty$}, fun ($c) {
    my $tempdir = $c->{stash}->{scenario}->{liveos_mountpoint}->child('tmp');
    ok(
        ! -d $tempdir || scalar($tempdir->children) == 0
    );
};

Then qr{^I should be told "([^"]+)"$}, fun ($c) {
    my $expected_err = $c->matches->[0];
    like($c->{stash}->{scenario}->{install_output}, qr{$expected_err});
};

fun squashfs_in_system_partition ($liveos_mountpoint) {
    grep {
        $_ =~ m{[.]squashfs \z}xms;
    } path($liveos_mountpoint, 'live')->children
}

Then qr{^the system partition should contain (\d+) SquashFS$}, fun ($c) {
    my $expected_squashfs = $c->matches->[0];
    is(
        scalar(squashfs_in_system_partition(
            $c->{stash}->{scenario}->{liveos_mountpoint}
        )),
        $expected_squashfs
    );
};

fun squashfs_in_modules_file ($modules_file) {
    my @lines = grep {
        ! m{\A[[:blank:]]*\z}
    } grep {
        m{[.]squashfs\z}
    } $modules_file->lines({chomp => 1});
}

Then qr{^the modules file should list (\d+) SquashFS$}, fun($c) {
    my $expected_squashfs = $c->matches->[0];
    is(
        squashfs_in_modules_file(
            path(
                $c->{stash}->{scenario}->{liveos_mountpoint},
                'live', 'Tails.module'
             )
        ),
        $expected_squashfs,
    );
};

Then qr{^the system partition should (not |)contain file "([^"]+)"(?: with content "([^"]*)")?$}, fun ($c) {
    my $should_exist     = $c->matches->[0] ? 0 : 1;
    my $file             = $c->matches->[1];
    my $expected_content = $c->matches->[2];

    if ($should_exist) {
        $file = path($c->{stash}->{scenario}->{liveos_mountpoint}, $file);
        ok($file->exists);
        if (defined $expected_content) {
            is($file->slurp, $expected_content);
        }
    }
    else {
        ok(! path($c->{stash}->{scenario}->{liveos_mountpoint}, $file)->exists);
    }
};

Then qr{^the last line of the modules file should be "([^"]+)"$}, fun ($c) {
    my $expected_last_module = $c->matches->[0];

    my @lines = grep {
        ! m{\A[[:blank:]]*\z}
    } path($c->{stash}->{scenario}->{liveos_mountpoint}, 'live', 'Tails.module')
        ->lines({chomp => 1});
    is($lines[-1], $expected_last_module);
};

Then qr{^the "([^"]+)" file in the system partition has been modified less than (\d+) minute[s]? ago}, fun ($c) {
    my $filename = $c->matches->[0];
    my $max_age  = $c->matches->[1];

    my $file = path($c->{stash}->{scenario}->{liveos_mountpoint}, $filename);
    my $min_mtime = DateTime->now - DateTime::Duration->new(minutes => $max_age);
    ok($file->stat->mtime >= $min_mtime->epoch);
};

Then qr{^the MBR is the new syslinux' one}, fun ($c) {
    my $expected_mbr = path('/usr/lib/SYSLINUX/gptmbr.bin')->slurp;
    my $mbr = stdout_as_root(
        'dd', 'status=none', 'if='.$c->{stash}->{scenario}->{boot_device},
        'bs=1', 'count='.length($expected_mbr)
    );

    # we don't use "is" as we don't want binary data to be output on screen
    ok($mbr eq $expected_mbr);
};

After fun ($c) {
    run_as_root('umount', $c->{stash}->{scenario}->{liveos_mountpoint});
    ${^CHILD_ERROR_NATIVE} == 0 or croak("Failed to umount system partition.");
    stdout_as_root(qw{kpartx -d}, $c->{stash}->{scenario}->{backing_file});
    ${^CHILD_ERROR_NATIVE} == 0 or croak("Failed to delete device mapping: $?.");
    $c->{stash}->{scenario}->{tempdir}->remove_tree;
};
