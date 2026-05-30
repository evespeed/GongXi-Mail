import { createHash } from 'crypto';
import prisma from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { AppError } from '../../plugins/error.js';
import { emailService } from './email.service.js';
import { mailService } from '../mail/mail.service.js';
import type { Prisma } from '@prisma/client';

type Mailbox = 'INBOX' | 'Junk';
type MailFetchStrategy = 'GRAPH_FIRST' | 'IMAP_FIRST' | 'GRAPH_ONLY' | 'IMAP_ONLY';

interface ProviderMessage {
    id: string;
    from: string;
    subject: string;
    text: string;
    html: string;
    date: string;
}

interface ListMailsInput {
    mailbox?: string;
    page?: number;
    pageSize?: number;
}

interface SyncMailboxInput {
    mailbox?: string;
    limit?: number;
    trigger?: 'IMPORT' | 'MANUAL';
    markInsertedAsNew?: boolean;
}

interface SyncManyInput {
    mailboxes?: string[];
    limit?: number;
    concurrency?: number;
    trigger?: 'IMPORT' | 'MANUAL';
    markInsertedAsNew?: boolean;
}

function normalizeMailbox(mailbox?: string): Mailbox {
    const normalized = String(mailbox || 'INBOX').trim().toLowerCase();
    if (normalized === 'junk' || normalized === 'junkemail' || normalized === 'junk email') {
        return 'Junk';
    }
    return 'INBOX';
}

function toDateOrNull(value?: string | null): Date | null {
    if (!value) {
        return null;
    }
    const time = new Date(value);
    return Number.isNaN(time.getTime()) ? null : time;
}

function truncate(value: string | undefined | null, maxLength: number): string | null {
    if (!value) {
        return null;
    }
    const normalized = value.trim();
    if (!normalized) {
        return null;
    }
    return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

function stripHtml(html?: string | null): string {
    if (!html) {
        return '';
    }
    return html
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<[^>]+>/g, ' ');
}

function buildPreview(message: ProviderMessage): string | null {
    const source = message.text || stripHtml(message.html);
    const preview = source.replace(/\s+/g, ' ').trim();
    return preview ? preview.slice(0, 500) : null;
}

function hashId(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function normalizeProviderMessageId(message: ProviderMessage, emailAccountId: number, mailbox: Mailbox): string {
    const raw = String(message.id || '').trim()
        || `${emailAccountId}|${mailbox}|${message.from}|${message.subject}|${message.date}|${message.text.slice(0, 80)}`;

    if (raw.length <= 255) {
        return raw;
    }

    return `hash_${hashId(raw)}`;
}

function serializeMailSummary(mail: {
    id: number;
    mailbox: string;
    providerMessageId: string;
    from: string | null;
    subject: string | null;
    bodyPreview: string | null;
    sentAt: Date | null;
    receivedAt: Date | null;
    firstFetchedAt: Date;
    lastFetchedAt: Date;
    isNew: boolean;
}) {
    return {
        id: mail.id,
        mailbox: mail.mailbox,
        providerMessageId: mail.providerMessageId,
        from: mail.from,
        subject: mail.subject,
        bodyPreview: mail.bodyPreview,
        sentAt: mail.sentAt,
        receivedAt: mail.receivedAt,
        firstFetchedAt: mail.firstFetchedAt,
        lastFetchedAt: mail.lastFetchedAt,
        isNew: mail.isNew,
    };
}

export const mailCacheService = {
    normalizeMailbox,

    async listMails(emailAccountId: number, input: ListMailsInput) {
        const mailbox = normalizeMailbox(input.mailbox);
        const page = Math.max(1, input.page || 1);
        const pageSize = Math.min(200, Math.max(1, input.pageSize || 100));
        const skip = (page - 1) * pageSize;

        const where: Prisma.StoredMailWhereInput = {
            emailAccountId,
            mailbox,
        };

        const [messages, total] = await Promise.all([
            prisma.storedMail.findMany({
                where,
                select: {
                    id: true,
                    mailbox: true,
                    providerMessageId: true,
                    from: true,
                    subject: true,
                    bodyPreview: true,
                    sentAt: true,
                    receivedAt: true,
                    firstFetchedAt: true,
                    lastFetchedAt: true,
                    isNew: true,
                },
                orderBy: [
                    { sentAt: 'desc' },
                    { id: 'desc' },
                ],
                skip,
                take: pageSize,
            }),
            prisma.storedMail.count({ where }),
        ]);

        return {
            mailbox,
            page,
            pageSize,
            total,
            messages: messages.map(serializeMailSummary),
        };
    },

    async getMailDetail(emailAccountId: number, mailId: number) {
        const mail = await prisma.storedMail.findFirst({
            where: {
                id: mailId,
                emailAccountId,
            },
            select: {
                id: true,
                mailbox: true,
                providerMessageId: true,
                from: true,
                subject: true,
                bodyPreview: true,
                text: true,
                html: true,
                sentAt: true,
                receivedAt: true,
                firstFetchedAt: true,
                lastFetchedAt: true,
                isNew: true,
            },
        });

        if (!mail) {
            throw new AppError('MAIL_NOT_FOUND', 'Mail not found', 404);
        }

        return mail;
    },

    async syncMailbox(emailAccountId: number, input: SyncMailboxInput = {}) {
        const mailbox = normalizeMailbox(input.mailbox);
        const limit = Math.min(200, Math.max(1, input.limit || 100));
        const markInsertedAsNew = input.markInsertedAsNew ?? input.trigger !== 'IMPORT';
        const startedAt = new Date();

        const emailData = await emailService.getById(emailAccountId, true);
        const refreshToken = typeof emailData.refreshToken === 'string' ? emailData.refreshToken : '';
        if (!refreshToken) {
            throw new AppError('EMAIL_TOKEN_MISSING', 'Email refresh token is missing', 400);
        }

        const credentials = {
            id: emailData.id,
            email: emailData.email,
            clientId: emailData.clientId,
            refreshToken,
            autoAssigned: false,
            fetchStrategy: emailData.group?.fetchStrategy as MailFetchStrategy | undefined,
        };

        try {
            const latestLocalMail = markInsertedAsNew
                ? await prisma.storedMail.findFirst({
                    where: {
                        emailAccountId: emailData.id,
                        mailbox,
                        sentAt: { not: null },
                    },
                    select: { sentAt: true },
                    orderBy: [
                        { sentAt: 'desc' },
                        { id: 'desc' },
                    ],
                })
                : null;
            const since = latestLocalMail?.sentAt
                ? new Date(latestLocalMail.sentAt.getTime() - 24 * 60 * 60 * 1000)
                : undefined;
            const fetchResult = await mailService.getEmails(credentials, { mailbox, limit, since });
            const fetchedAt = new Date();
            let inserted = 0;
            let updated = 0;

            if (markInsertedAsNew) {
                await prisma.storedMail.updateMany({
                    where: {
                        emailAccountId: emailData.id,
                        mailbox,
                        isNew: true,
                    },
                    data: { isNew: false },
                });
            }

            for (const message of fetchResult.messages as ProviderMessage[]) {
                const providerMessageId = normalizeProviderMessageId(message, emailData.id, mailbox);
                const sentAt = toDateOrNull(message.date);
                const existing = await prisma.storedMail.findUnique({
                    where: {
                        emailAccountId_mailbox_providerMessageId: {
                            emailAccountId: emailData.id,
                            mailbox,
                            providerMessageId,
                        },
                    },
                    select: { id: true },
                });

                const data = {
                    from: truncate(message.from, 500),
                    subject: truncate(message.subject, 500),
                    bodyPreview: buildPreview(message),
                    text: message.text || null,
                    html: message.html || null,
                    sentAt,
                    receivedAt: sentAt,
                    lastFetchedAt: fetchedAt,
                };

                if (existing) {
                    await prisma.storedMail.update({
                        where: { id: existing.id },
                        data,
                    });
                    updated++;
                } else {
                    await prisma.storedMail.create({
                        data: {
                            ...data,
                            emailAccountId: emailData.id,
                            mailbox,
                            providerMessageId,
                            firstFetchedAt: fetchedAt,
                            isNew: markInsertedAsNew,
                        },
                    });
                    inserted++;
                }
            }

            await emailService.updateStatus(emailData.id, 'ACTIVE', null);

            return {
                emailId: emailData.id,
                email: emailData.email,
                mailbox,
                method: fetchResult.method,
                fetched: fetchResult.count,
                inserted,
                updated,
                since,
                startedAt,
                completedAt: fetchedAt,
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Sync failed';
            await emailService.updateStatus(emailData.id, 'ERROR', message.slice(0, 1000));
            throw err;
        }
    },

    async syncManyMailboxes(emailAccountIds: number[], input: SyncManyInput = {}) {
        const uniqueEmailIds = Array.from(new Set(emailAccountIds.filter((id) => Number.isFinite(id) && id > 0)));
        const mailboxes = Array.from(new Set((input.mailboxes?.length ? input.mailboxes : ['INBOX', 'Junk']).map(normalizeMailbox)));
        const tasks = uniqueEmailIds.flatMap((emailId) => mailboxes.map((mailbox) => ({ emailId, mailbox })));
        const concurrency = Math.min(10, Math.max(1, input.concurrency || 2));
        const results: Array<Awaited<ReturnType<typeof this.syncMailbox>>> = [];
        const failures: Array<{ emailId: number; mailbox: Mailbox; message: string }> = [];
        let cursor = 0;

        const worker = async () => {
            while (cursor < tasks.length) {
                const task = tasks[cursor++];
                try {
                    const result = await this.syncMailbox(task.emailId, {
                        mailbox: task.mailbox,
                        limit: input.limit,
                        trigger: input.trigger,
                        markInsertedAsNew: input.markInsertedAsNew,
                    });
                    results.push(result);
                } catch (err) {
                    const message = err instanceof Error ? err.message : 'Sync failed';
                    failures.push({ emailId: task.emailId, mailbox: task.mailbox, message });
                    logger.warn({ err, emailId: task.emailId, mailbox: task.mailbox }, 'Mail cache background sync failed');
                }
            }
        };

        await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));

        return {
            totalEmails: uniqueEmailIds.length,
            totalTasks: tasks.length,
            success: results.length,
            failed: failures.length,
            results,
            failures,
        };
    },

    async deleteMailbox(emailAccountId: number, mailbox?: string) {
        const normalizedMailbox = normalizeMailbox(mailbox);
        const result = await prisma.storedMail.deleteMany({
            where: {
                emailAccountId,
                mailbox: normalizedMailbox,
            },
        });
        return { deleted: result.count, mailbox: normalizedMailbox };
    },
};
