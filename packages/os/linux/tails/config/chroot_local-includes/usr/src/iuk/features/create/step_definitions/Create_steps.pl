#!perl

use strictures 2;

use lib "lib";

use Carp;
use Carp::Assert;
use Cwd;
use Data::Dumper;
use English qw{-no_match_vars};
use Function::Parameters;
use IPC::System::Simple qw{capture capturex systemx $EXITVAL EXIT_ANY};
use Test::More;
use Test::BDD::Cucumber::StepFile;

use Path::Tiny;
use Types::Path::Tiny qw{Path};

use Tails::IUK;
use Tails::IUK::Read;
use Tails::IUK::Utils qw{run_as_root};


my $bindir = path(__FILE__)->parent->parent->parent->parent->child('bin')->absolute;
use Env qw{@PATH};
unshift @PATH, $bindir;

Given qr{^a usable temporary directory$}, fun ($c) {
    my $dirname = Path::Tiny->tempdir(CLEANUP => 0);
    $c->{stash}->{scenario}->{tempdir} = $dirname;
    ok(defined($dirname));
};

fun inject_new_bootloader_bits_into($dir) {
    for (qw{EFI/BOOT/bootx64.efi utils/linux/syslinux}) {
        my $injected_file = path($dir, $_);
        $injected_file->parent->mkpath;
        $injected_file->touch;
        ok($injected_file->is_file);
    }
}

fun geniso($srcdir, $outfile) {
    path($srcdir, 'isolinux')->mkpath;
    assert(path($srcdir, 'isolinux')->is_dir);
    path($srcdir, 'isolinux', 'isolinux.cfg')->spew(
        "bla\n   bli/isolinux/blu\n\n\n bla/isolinux/"
    );
    assert(path($srcdir, 'isolinux', 'isolinux.cfg')->exists);

    path($srcdir, 'live')->mkpath;
    if (! -e path($srcdir, 'live', 'filesystem.squashfs')) {
        my $squashfs_tempdir = Path::Tiny->tempdir;
        # an empty SquashFS is invalid
        path($squashfs_tempdir, '.placeholder')->touch;
        capture("gensquashfs --quiet --pack-dir '$squashfs_tempdir' '$srcdir/live/filesystem.squashfs' 2>/dev/null");
    }
    capture(EXIT_ANY,
            "genisoimage --quiet -J -l -cache-inodes -allow-multidot -o '$outfile' '$srcdir' 2>/dev/null");
    $EXITVAL == 0
}

Given qr{^(an old|a new) ISO image(?: that does not contain file "([^"]+)")?$}, fun ($c) {
    my $generation = $c->matches->[0] eq 'an old' ? 'old' : 'new';
    my $file = $c->matches->[1];
    my $basename = $generation eq 'old' ? 'old.iso' : 'new.iso';
    my $filename = path($c->{stash}->{scenario}->{tempdir}, $basename);
    my $iso_tempdir = Path::Tiny->tempdir;
    if (defined $file) {
        assert(length $file);
        ok(! -e path($iso_tempdir, $file));
    }
    inject_new_bootloader_bits_into($iso_tempdir) if $generation eq 'new';
    ok(geniso($iso_tempdir, $filename));
};

Given qr{^(an old|a new) ISO image that contains file "([^"]+)"$}, fun ($c) {
    my $generation = $c->matches->[0];
    my $file = $c->matches->[1];
    my $basename = $generation eq 'an old' ? 'old.iso' : 'new.iso';
    my $filename = path($c->{stash}->{scenario}->{tempdir}, $basename);
    my $iso_tempdir = Path::Tiny->tempdir;
    my $file_in_iso = path($iso_tempdir, $file);
    $file_in_iso->parent->mkpath();
    $file_in_iso->touch;
    ok($file_in_iso->is_file);
    inject_new_bootloader_bits_into($iso_tempdir) if $generation eq 'new';
    ok(geniso($iso_tempdir, $filename));
};

Given qr{^(?:two identical ISO images|two ISO images that contain the same set of kernels|two ISO images that contain the same bootloader configuration)$}, fun ($c) {
    for my $generation (qw{old new}) {
        my $basename = $generation.'.iso';
        my $filename = path($c->{stash}->{scenario}->{tempdir}, $basename);
        my $iso_tempdir = Path::Tiny->tempdir;
        path($iso_tempdir, 'live')->mkpath;
        inject_new_bootloader_bits_into($iso_tempdir);
        geniso($iso_tempdir, $filename) or croak "Failed to generate ISO image.";
    }
    ok(
        -f path($c->{stash}->{scenario}->{tempdir}, 'old.iso')
     && -f path($c->{stash}->{scenario}->{tempdir}, 'new.iso')
    );
};

Given qr{^two ISO images when the kernel was upgraded$}, fun ($c) {
    for my $generation (qw{old new}) {
        my $basename = $generation.'.iso';
        my $filename = path($c->{stash}->{scenario}->{tempdir}, $basename);
        my $iso_tempdir = Path::Tiny->tempdir;
        path($iso_tempdir, 'live')->mkpath;
        for (qw{vmlinuz initrd.img}) {
            path($iso_tempdir, 'live', $_)->spew($generation);
        }
        inject_new_bootloader_bits_into($iso_tempdir) if $generation eq 'new';
        geniso($iso_tempdir, $filename) or croak "Failed to generate ISO image.";
    }

    ok(
        -f path($c->{stash}->{scenario}->{tempdir}, 'old.iso')
     && -f path($c->{stash}->{scenario}->{tempdir}, 'new.iso')
    );
};

Given qr{^two ISO images when a new kernel was added$}, fun ($c) {
    for my $generation (qw{old new}) {
        my $basename = $generation.'.iso';
        my $filename = path($c->{stash}->{scenario}->{tempdir}, $basename);
        my $iso_tempdir = Path::Tiny->tempdir;
        path($iso_tempdir, 'live')->mkpath;
        for (qw{vmlinuz initrd.img}) {
            path($iso_tempdir, 'live', $_)->spew("same content");
        }
        if ($generation eq 'new') {
            for (qw{vmlinuz2 initrd2.img}) {
                path($iso_tempdir, 'live', $_)->spew($generation);
            }
            inject_new_bootloader_bits_into($iso_tempdir);
        }
        geniso($iso_tempdir, $filename) or croak "Failed to generate ISO image.";
    }

    ok(
        -f path($c->{stash}->{scenario}->{tempdir}, 'old.iso')
     && -f path($c->{stash}->{scenario}->{tempdir}, 'new.iso')
    );
};

Given qr{^(an old|a new) ISO image whose filesystem.squashfs( does not|) contains? file "([^"]+)"(?:| modified at ([0-9]+)| owned by ([a-z-]+))$}, fun ($c) {
    my $generation = $c->matches->[0] eq 'an old' ? 'old' : 'new';
    my $contains = $c->matches->[1] eq "" ? 1 : 0;
    my $file     = $c->matches->[2];
    my ($mtime, $owner);
    if (defined $c->matches->[3] && $c->matches->[3] =~ m{\A[0-9]+\z}) {
        $mtime = $c->matches->[3];
    } elsif (defined $c->matches->[4] && $c->matches->[4] =~ m{\A[a-z-]+\z}) {
        $owner = $c->matches->[4];
    }

    my $iso_basename = $generation eq 'old' ? 'old.iso' : 'new.iso';
    my $iso_filename = path($c->{stash}->{scenario}->{tempdir}, $iso_basename);
    my $iso_tempdir = Path::Tiny->tempdir;
    my $squashfs_tempdir = Path::Tiny->tempdir;
    # an empty SquashFS is invalid
    path($squashfs_tempdir, '.placeholder')->touch;
    if ($contains) {
        path($squashfs_tempdir, $file)->parent->mkpath();
        path($squashfs_tempdir, $file)->touch;
        utime($mtime, $mtime, path($squashfs_tempdir, $file)) if defined($mtime);
        run_as_root('chown', $owner, path($squashfs_tempdir, $file)) if defined($owner);
    }
    path($iso_tempdir, 'live')->mkpath();
    systemx('sudo', 'chmod', '-R', 'go+rwX', $squashfs_tempdir);
    systemx(
        'gensquashfs', '--quiet', '--keep-time',
        '--pack-dir', $squashfs_tempdir,
        $iso_tempdir->child('live/filesystem.squashfs')
    );
    inject_new_bootloader_bits_into($iso_tempdir) if $generation eq 'new';
    ok(geniso($iso_tempdir, $iso_filename));
};

Given qr{^two ISO images that do not contain the same bootloader configuration$}, fun ($c) {
    for my $generation (qw{old new}) {
        my $basename = $generation.'.iso';
        my $filename = path($c->{stash}->{scenario}->{tempdir}, $basename);
        my $iso_tempdir = Path::Tiny->tempdir;
        path($iso_tempdir, 'isolinux')->mkpath;
        for (qw{live.cfg}) {
            path($iso_tempdir, 'isolinux', $_)->spew($generation);
        }
        inject_new_bootloader_bits_into($iso_tempdir) if $generation eq 'new';
        geniso($iso_tempdir, $filename) or croak "Failed to generate ISO image.";
    }

    ok(
        -f path($c->{stash}->{scenario}->{tempdir}, 'old.iso')
     && -f path($c->{stash}->{scenario}->{tempdir}, 'new.iso')
    );
};

When qr{^I create an IUK$}, fun ($c) {
    my %args;
    $c->{stash}->{scenario}->{squashfs_diff_name} =
        'Tails_amd64_0.11.1_to_0.11.2.squashfs';

    my $iuk_path = path($c->{stash}->{scenario}->{tempdir}, 'test.iuk');

    my $cmdline =
        # on overlayfs, deleted files are stored using character devices,
        # that one needs to be root to create
        "sudo SOURCE_DATE_EPOCH=$ENV{SOURCE_DATE_EPOCH} " .
        path($bindir, "tails-create-iuk") .
        ' --old_iso "' .
        path($c->{stash}->{scenario}->{tempdir}, 'old.iso') . '" ' .
        ' --new_iso "' .
        path($c->{stash}->{scenario}->{tempdir}, 'new.iso') . '"' .
        ' --squashfs_diff_name "'.$c->{stash}->{scenario}->{squashfs_diff_name}.'"' .
        ' --outfile "' . $iuk_path . '"'
    ;

    if (exists $c->{stash}->{scenario}->{squashfs_diff}) {
        $cmdline .=
            ' --squashfs_diff "' . $c->{stash}->{scenario}->{squashfs_diff} . '"';
    }

    $c->{stash}->{scenario}->{create_output} = capture(
        EXIT_ANY,
        "umask 077 && $cmdline 2>&1"
    );
    $c->{stash}->{scenario}->{create_exit_code} = $EXITVAL;

    $c->{stash}->{scenario}->{create_exit_code} == 0
        or warn $c->{stash}->{scenario}->{create_output};

    $c->{stash}->{scenario}->{iuk_path} = $iuk_path;

    my $iuk_in = Tails::IUK::Read->new_from_file($iuk_path);

    my @gids = split(/ /, $GID);
    system(qw{sudo chown}, "$UID:$gids[0]", $iuk_path);
    ${^CHILD_ERROR_NATIVE} == 0 or croak "Could not chown '$iuk_path': $!";

    $c->{stash}->{scenario}->{iuk_in} = $iuk_in;
    ok(defined($iuk_in));
};

Then qr{^the created IUK is a SquashFS image$}, fun ($c) {
    system('rdsquashfs --list / ' . $c->{stash}->{scenario}->{iuk_path} . '>/dev/null 2>&1');
    is(${^CHILD_ERROR_NATIVE}, 0, "The generated IUK is not a SquashFS image");
};

Then qr{^the saved IUK contains a "([^"]*)" file$}, fun ($c) {
    my $file = path($c->matches->[0]);
    ok($c->{stash}->{scenario}->{iuk_in}->contains_file($file));
};

fun squashfs_contains_only_files_owned_by ($squashfs_filename, $owner, $group) {
    map { like(
        $_,
        qr{
             \A            # at the beginning of the string
             (?:file|dir)  # file type
             [[:space:]]+
             .+?           # path
             [[:space:]]+
             [[:digit:]]+  # permissions
             [[:space:]]+
             $owner        # UID
             [[:space:]]+
             $group        # GID
         }xms,
        "line looks like a file description with owner $owner and group $group"
    ) } split(/\n/, `rdsquashfs --quiet --describe '$squashfs_filename'`);
}

Then qr{^all files in the saved IUK belong to owner 0 and group 0$}, fun ($c) {
    ok(squashfs_contains_only_files_owned_by(
        $c->{stash}->{scenario}->{iuk_in}->file,
        0,
        0,
    ));
};

Then qr{^the "([^"]+)" file in the saved IUK contains "([^"]*)"$}, fun ($c) {
    my $file = $c->matches->[0];
    my $expected_content = $c->matches->[1];
    is(
        $c->{stash}->{scenario}->{iuk_in}->get_content(path($file)),
        $expected_content
    );
};

fun _file_content_in_iuk_like(
    $iuk_in, Path $filename, $regexp, $should_match
) {
    assert(defined $iuk_in && defined $filename);
    assert(defined $regexp && defined $should_match);

    unless ($iuk_in->contains_file($filename)) {
        warn "The IUK does not contain $filename, so we can't check its content.";
        return;
    }

    my $content = $iuk_in->get_content($filename);

    if ($should_match) {
        return $content =~ m{$regexp}xms;
    }
    else {
        return $content !~ m{$regexp}xms;
    }
}

fun file_content_in_iuk_like($iuk_in, Path $filename, $regexp) {
    assert(defined $iuk_in && defined $regexp);
    _file_content_in_iuk_like(@_, 1);
}

fun file_content_in_iuk_unlike($iuk_in, Path $filename, $regexp) {
    assert(defined $iuk_in && defined $regexp);
    _file_content_in_iuk_like(@_, 0);
}

fun squashfs_in_iuk_contains(:$iuk_in, :$squashfs_name, :$expected_file,
                             :$expected_mtime, :$expected_owner) {
    my $squashfs_path = path('overlay', 'live', $squashfs_name);
    die "SquashFS '$squashfs_name' not found in the IUK"
        unless $iuk_in->contains_file($squashfs_path);

    my $orig_cwd = getcwd;
    my $tempdir = Path::Tiny->tempdir;
    chdir $tempdir;
    $tempdir->child('squashfs-root')->mkpath;
    capturex(EXIT_ANY,
        # on overlayfs, deleted files are stored using character devices,
        # that one needs to be root to create
        'sudo',
        'rdsquashfs', '--quiet', '--set-times', '--set-xattr', '--chown',
        '--unpack-root', $tempdir->child('squashfs-root'),
        '--unpack-path', "/",
        $iuk_in->mountpoint->child($squashfs_path),
    );
    my $exists = $tempdir->child('squashfs-root', $expected_file)->exists;
    chdir $orig_cwd;

    # Ensure $tempdir can be cleaned up and the $expected_mtime test can access
    # the file it needs to
    my @gids = split(/ /, $GID);
    systemx(
        qw{sudo chmod -R go+rwX},
        $tempdir->child('squashfs-root')
    );

    return unless $exists;

    # In passing, verify there is no trusted.overlay.* xattr,
    # which would make IUKs non-reproducible
    my $xattrs = capturex(
        'sudo', 'rdsquashfs', '--xattr',
        '/',
        $iuk_in->mountpoint->child($squashfs_path),
    );
    if ($xattrs) {
        warn "The root directory in the SquashFS diff has xattrs:\n$xattrs";
        return;
    }

    if (defined $expected_mtime) {
        $expected_mtime = $ENV{SOURCE_DATE_EPOCH} if $expected_mtime eq 'SOURCE_DATE_EPOCH';
        return unless $expected_mtime == $tempdir->child('squashfs-root', $expected_file)->stat->mtime
    }

    if (defined $expected_owner) {
        return unless $expected_owner eq getpwuid($tempdir->child('squashfs-root', $expected_file)->stat->uid)
    }

    return 1;
}

fun squashfs_in_iuk_deletes($iuk_in, $squashfs_name, $deleted_file) {
    my $squashfs_path = path('overlay', 'live', $squashfs_name);
    my $orig_cwd = getcwd;
    my $tempdir = Path::Tiny->tempdir;
    chdir $tempdir;
    die "SquashFS '$squashfs_name' not found in the IUK"
        unless $iuk_in->contains_file($squashfs_path);

    my $old_dir = Path::Tiny->tempdir;
    path($old_dir, $deleted_file)->touch;

    my $new_dir = Path::Tiny->tempdir;
    capturex(
        # on overlayfs, deleted files are stored using character devices,
        # that one needs to be root to create
        'sudo',
        "rdsquashfs", '--quiet', "--unpack-root", $new_dir,
        '--unpack-path', '.',
        $iuk_in->mountpoint->child($squashfs_path),
    );
    chdir $orig_cwd;

    # Ensure $new_dir can be cleaned up
    my @gids = split(/ /, $GID);
    systemx(qw{sudo chown -R}, "$UID:$gids[0]", $new_dir);

    my $union_basedir    = Path::Tiny->tempdir;
    my $union_workdir    = path($union_basedir, 'work');
    my $union_mountpoint = path($union_basedir, 'mount');
    $_->mkpath for ($union_workdir, $union_mountpoint);
    my @mount_args = (
        '-t', 'overlay',
        '-o', sprintf("noatime,lowerdir=%s,upperdir=%s,workdir=%s",
                      $old_dir, $new_dir, $union_workdir),
        'overlay'
        );

    capturex(
        qw{sudo -n mount}, @mount_args,
        $union_mountpoint
    );

    my $exists = -e path($union_mountpoint, $deleted_file);
    system(qw{sudo umount}, "$union_mountpoint");
    return ! $exists;
}

Then qr{^the saved IUK contains an? "([^"]+)" directory$}, fun ($c) {
    my $dir = $c->matches->[0];
    ok($c->{stash}->{scenario}->{iuk_in}->mountpoint->child($dir)->is_dir);
};

fun overlay_directory_in_iuk_contains($iuk_in, $expected_file) {
    grep { 'overlay/' . $expected_file eq $_->stringify } $iuk_in->list_files;
}

Then qr{^the overlay directory in the saved IUK (contains|does not contain) "([^"]+)"$}, fun ($c) {
    my $should_contain = $c->matches->[0] eq 'contains';
    my $expected_file = $c->matches->[1];

    $should_contain ?
        ok(overlay_directory_in_iuk_contains(
            $c->{stash}->{scenario}->{iuk_in},
            $expected_file,
        ))
        :
        ok(! overlay_directory_in_iuk_contains(
            $c->{stash}->{scenario}->{iuk_in},
            $expected_file,
        ))
};

Then qr{^the delete_files list (contains|does not contain) "([^"]+)"$}, fun ($c) {
    my $wanted            = $c->matches->[0] eq 'contains' ? 1 : 0;
    my $expected_filename = $c->matches->[1];

    is(
        scalar(grep {
            $_ eq $expected_filename
        } @{$c->{stash}->{scenario}->{iuk_in}->delete_files}),
        $wanted
    );
};

Then qr{^the delete_files list is empty$}, fun ($c) {
    is($c->{stash}->{scenario}->{iuk_in}->delete_files_count, 0);
};

Then qr{^the saved IUK contains a SquashFS that contains file "([^"]+)"(?:| modified at ([0-9]+|SOURCE_DATE_EPOCH)| owned by ([a-z-]+))$}, fun ($c) {
    my $expected_file  = $c->matches->[0];
    my ($expected_mtime, $expected_owner);
    if (defined $c->matches->[1] && $c->matches->[1] =~ m{\A[0-9]+\z}) {
        $expected_mtime = $c->matches->[1];
    } elsif (defined $c->matches->[1] && $c->matches->[1] eq "SOURCE_DATE_EPOCH") {
        $expected_mtime = $c->matches->[1];
    } elsif (defined $c->matches->[2] && $c->matches->[2] =~ m{\A[a-z-]+\z}) {
        $expected_owner = $c->matches->[2];
    } else {
        croak "Test suite implementation error";
    }

    ok(squashfs_in_iuk_contains(
        iuk_in         => $c->{stash}->{scenario}->{iuk_in},
        squashfs_name  => $c->{stash}->{scenario}->{squashfs_diff_name},
        expected_file  => $expected_file,
        expected_mtime => $expected_mtime,
        expected_owner => $expected_owner,
    ));
};

Then qr{^the overlay directory in the saved IUK contains a SquashFS diff$}, fun ($c) {
    ok(overlay_directory_in_iuk_contains(
        $c->{stash}->{scenario}->{iuk_in},
        path('live', $c->{stash}->{scenario}->{squashfs_diff_name}),
    ));
};

Then qr{^the saved IUK contains a SquashFS that deletes file "([^"]+)"$}, fun ($c) {
    my $deleted_file = $c->matches->[0];

    ok(squashfs_in_iuk_deletes(
        $c->{stash}->{scenario}->{iuk_in},
        $c->{stash}->{scenario}->{squashfs_diff_name},
        $deleted_file
    ));
};

Then qr{^the saved IUK contains the new bootloader configuration$}, fun ($c) {
    my $live_cfg_path = path('overlay/syslinux/live.cfg');
    is(
        $c->{stash}->{scenario}->{iuk_in}->get_content($live_cfg_path),
        'new'
    );
};

Then qr{^the overlay directory contains an upgraded syslinux configuration$}, fun ($c) {
    my @wanted_files   = qw{syslinux/syslinux.cfg EFI/BOOT/bootx64.efi utils/linux/syslinux};
    my @unwanted_files = qw{syslinux/isolinux.cfg};

    map {
        ok(overlay_directory_in_iuk_contains(
            $c->{stash}->{scenario}->{iuk_in}, $_,
        ), "the overlay directory contains '$_'");
    } @wanted_files;

    map {
        ok(! overlay_directory_in_iuk_contains(
            $c->{stash}->{scenario}->{iuk_in}, $_,
        ), "the overlay directory does not contain '$_'");
    } @unwanted_files;

    ok(file_content_in_iuk_like(
            $c->{stash}->{scenario}->{iuk_in},
            path("overlay/syslinux/syslinux.cfg"),
            qr{/syslinux/}
    ), "overlay/syslinux/syslinux.cfg contains /syslinux/");

    ok(file_content_in_iuk_unlike(
            $c->{stash}->{scenario}->{iuk_in},
            path("overlay/syslinux/syslinux.cfg"),
            qr{/isolinux/}
    ), "overlay/syslinux/syslinux.cfg does not contain /isolinux/");

};
