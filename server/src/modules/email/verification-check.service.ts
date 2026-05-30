import prisma from '../../lib/prisma.js';
import { AppError } from '../../plugins/error.js';
import { mailCacheService } from './mail-cache.service.js';

const DISABLED_GROUP_NAME = '禁用';
const ACCESS_DEACTIVATED_SUBJECT = 'Access Deactivated';
const VERIFICATION_KEYWORD = 'verification code to continue';
const VERIFICATION_CODE_REGEX = /verification code to continue[\s\S]{0,240}?(\d{6})/i;
const CODE_LABEL_REGEX = /\bcode\s*[:：]\s*(\d{6})\b/i;

function stripHtml(html?: string | null): string {
    if (!html) {
        return '';
    }
    return html
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<[^>]+>/g, ' ');
}

function extractVerificationCode(mail: {
    subject: string | null;
    bodyPreview: string | null;
    text: string | null;
    html: string | null;
}): string | null {
    const content = [
        mail.subject || '',
        mail.bodyPreview || '',
        mail.text || '',
        stripHtml(mail.html),
    ].join('\n');

    if (content.toLowerCase().includes(VERIFICATION_KEYWORD)) {
        const keywordMatch = content.match(VERIFICATION_CODE_REGEX);
        if (keywordMatch?.[1]) {
            return keywordMatch[1];
        }
    }

    const codeLabelMatch = content.match(CODE_LABEL_REGEX);
    return codeLabelMatch?.[1] || null;
}

async function ensureDisabledGroup() {
    return prisma.emailGroup.upsert({
        where: { name: DISABLED_GROUP_NAME },
        update: {},
        create: {
            name: DISABLED_GROUP_NAME,
            description: '检测到 Access Deactivated 邮件后自动归组',
            fetchStrategy: 'IMAP_FIRST',
        },
    });
}

export const verificationCheckService = {
    async check(emailAccountId: number) {
        const account = await prisma.emailAccount.findUnique({
            where: { id: emailAccountId },
            select: {
                id: true,
                email: true,
            },
        });
        if (!account) {
            throw new AppError('EMAIL_NOT_FOUND', 'Email account not found', 404);
        }

        const sync = await mailCacheService.syncMailbox(emailAccountId, {
            mailbox: 'INBOX',
            limit: 20,
            trigger: 'MANUAL',
            markInsertedAsNew: true,
        });

        const checkedAt = new Date();
        const deactivatedMail = await prisma.storedMail.findFirst({
            where: {
                emailAccountId,
                mailbox: 'INBOX',
                subject: {
                    contains: ACCESS_DEACTIVATED_SUBJECT,
                    mode: 'insensitive',
                },
            },
            select: {
                id: true,
                subject: true,
                sentAt: true,
            },
            orderBy: [
                { sentAt: 'desc' },
                { id: 'desc' },
            ],
        });

        if (deactivatedMail) {
            const disabledGroup = await ensureDisabledGroup();
            await prisma.emailAccount.update({
                where: { id: emailAccountId },
                data: {
                    groupId: disabledGroup.id,
                    status: 'DISABLED',
                    lastVerificationCode: null,
                    lastVerificationMailAt: null,
                    lastVerificationCheckedAt: checkedAt,
                    errorMessage: 'Access Deactivated mail detected',
                },
            });

            return {
                status: 'DEACTIVATED' as const,
                emailId: account.id,
                email: account.email,
                code: null,
                mailSentAt: deactivatedMail.sentAt,
                matchedSubject: deactivatedMail.subject,
                disabledGroup: {
                    id: disabledGroup.id,
                    name: disabledGroup.name,
                },
                sync,
                checkedAt,
            };
        }

        const latestMail = await prisma.storedMail.findFirst({
            where: {
                emailAccountId,
                mailbox: 'INBOX',
            },
            select: {
                id: true,
                subject: true,
                bodyPreview: true,
                text: true,
                html: true,
                sentAt: true,
                receivedAt: true,
            },
            orderBy: [
                { sentAt: 'desc' },
                { id: 'desc' },
            ],
        });

        const code = latestMail ? extractVerificationCode(latestMail) : null;
        const mailSentAt = code ? (latestMail?.sentAt || latestMail?.receivedAt || null) : null;

        await prisma.emailAccount.update({
            where: { id: emailAccountId },
            data: {
                lastVerificationCode: code,
                lastVerificationMailAt: mailSentAt,
                lastVerificationCheckedAt: checkedAt,
                errorMessage: code ? null : undefined,
            },
        });

        return {
            status: code ? 'CODE_FOUND' as const : 'NO_CODE' as const,
            emailId: account.id,
            email: account.email,
            code,
            mailSentAt,
            matchedSubject: latestMail?.subject || null,
            sync,
            checkedAt,
        };
    },
};
